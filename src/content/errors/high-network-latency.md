---
title: How to investigate high network latency on Linux
description: A practical Linux latency guide that separates RTT, TCP connect time, TLS setup, server processing, queueing, retransmissions, and slow dependencies.
slug: high-network-latency
publishedAt: 2026-05-05
updatedAt: 2026-05-29
tags:
  - Linux
  - networking
  - latency
related:
  - tcp-retransmissions
  - intermittent-packet-loss
  - curl-28-operation-timed-out
  - io-timeout
---

High network latency is not one problem. It can mean high RTT（round-trip time，往返时延）, slow TCP connect, slow TLS handshake, queueing inside a load balancer, packet loss causing retransmissions, receiver pressure, or an application dependency that is slow after the network path has already done its job.

The common mistake is to call every slow request "network latency." If TCP connect is fast but TTFB（time to first byte，首字节时间）is slow, the wire path may be fine while the application, proxy, or database is slow.

The useful question is:

```text
Which latency component increased: DNS, TCP connect, TLS, first byte, response body, packet retransmission, host queueing, or application dependency time?
```

Do not tune kernel settings, raise timeouts, or blame the provider until the slow component is identified.

## Start With A Latency Timeline

For an HTTPS request, draw the path like this:

```text
client
  -> DNS lookup
  -> TCP connect
  -> TLS handshake
  -> request write
  -> proxy queue / upstream selection
  -> application handler
  -> database / cache / downstream API
  -> first response byte
  -> response body transfer
```

Each segment has a different owner:

| Segment | Main evidence | First branch |
| --- | --- | --- |
| DNS lookup | curl `time_namelookup`, resolver logs | DNS, service discovery, search domains |
| TCP connect | curl `time_connect`, SYN retransmits, `ss` | route, firewall, listener, accept queue, packet loss |
| TLS handshake | curl `time_appconnect`, `openssl s_client` | SNI, certificates, TLS terminator, CPU/load |
| First byte | curl `time_starttransfer`, NGINX `$upstream_header_time` | proxy queue, app handler, dependencies |
| Body transfer | curl `time_total`, bytes sent, chunk gaps | large response, stream stall, slow client path |
| TCP retransmission | `ss -ti`, `netstat -s`, packet capture | packet loss, congestion, receiver pressure |
| Host queueing | CPU, softirq, accept queue, worker queue | overloaded host or app runtime |

Only some of these are "the network" in the provider/path sense.

## Measure HTTP Phase Timing First

Use curl timing fields:

```bash
curl -sS -o /dev/null \
  -w 'remote_ip=%{remote_ip} dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
  https://example.com/path
```

curl documents these timing values as seconds. They are cumulative from the start of the transfer. For example, `time_starttransfer` includes DNS, connect, TLS, request write, and waiting for the first response byte. Do not add all fields together.

Interpretation:

| Observation | Strong suspect |
| --- | --- |
| `dns` high | resolver, DNS search path, service discovery |
| `connect` high while DNS is low | route, firewall, listener, accept backlog, packet loss |
| `tls` high while connect is normal | TLS/SNI/cert path, TLS terminator load |
| `first_byte` high while connect/TLS are normal | app handler, proxy queue, database/cache/API latency |
| `total` high while first byte is normal | response body transfer, stream stall, slow client path |
| `remote_ip` changes between fast and slow runs | one backend, edge, route, or region is bad |

Repeat the test during the bad window:

```bash
for i in $(seq 1 20); do
  date -Is
  curl -sS -o /dev/null \
    -w "$i remote_ip=%{remote_ip} dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n" \
    https://example.com/path
done
```

One request proves little. Tail latency is about repeated high percentiles, bursts, and variance.

## RTT Is Not Full Request Latency

`ping` measures ICMP round-trip behavior. It does not measure DNS, TCP connect, TLS, application handler time, database latency, or response body transfer.

Use it as a low-level signal:

```bash
ping -c 20 example.com
mtr -rw example.com
```

Useful conclusions:

- RTT baseline is much higher from one region than another;
- destination loss or latency rises during the same incident window;
- multiple clients show the same destination path problem;
- path change correlates with application latency.

Weak conclusions:

- one middle hop in `mtr` shows loss but later hops are clean;
- one ping sample is slow;
- ping is clean, therefore HTTPS is healthy;
- tests are from your laptop while production callers run in private subnets.

ICMP can be rate-limited or routed differently. Treat it as supporting evidence, not final proof.

## Read mtr Without Overreacting

`mtr` is useful when interpreted carefully.

More credible pattern:

```text
loss or latency appears at a hop
the same or worse loss/latency continues to later hops
the final destination is affected
application errors rise in the same time window
```

Less credible pattern:

```text
one middle router shows ICMP loss
later hops and destination are clean
application traffic is unaffected
```

Intermediate routers often rate-limit ICMP responses to themselves while forwarding traffic normally. Do not escalate provider issues with only a middle-hop loss line.

## Check TCP And Host Evidence

Latency can be caused by retransmissions, congestion, receiver pressure, or host queueing.

```bash
ss -ti
ss -ti dst <peer-ip>
netstat -s | grep -Ei 'retrans|timeout|listen|overflow|reset'
sar -n TCP,ETCP 1 10
```

Useful `ss -ti` clues vary by kernel, but commonly include RTT, RTO, congestion window, retransmission state, delivery rate, and bytes retransmitted.

| Signal | Interpretation |
| --- | --- |
| retransmissions rise during incident | sender believes data or ACKs are missing |
| RTT rises before retransmissions | queueing, congestion, or receiver pressure |
| send queue does not drain | receiver/path/app backpressure |
| listen overflow/drop counters rise | accept queue or listener pressure |
| one peer is worse than others | endpoint/path/node-specific issue |

Also check host saturation:

```bash
top
vmstat 1 5
mpstat -P ALL 1 5
cat /proc/softirqs
ip -s link
```

CPU, softirq, NIC, virtual network, and app worker pressure can create latency that looks like a network path problem.

## Separate Connect Latency From First-Byte Latency

This is the most important distinction in backend incidents.

### High connect time

Strong signals:

- curl `time_connect` is high;
- sockets are stuck in SYN state;
- packet capture shows SYN retransmissions;
- listener or accept queue counters rise;
- only one node, subnet, or route is affected.

First checks:

```bash
nc -vz -w 3 <ip> <port>
ss -tan state syn-sent
ss -ltn
netstat -s | grep -Ei 'listen|overflow|retrans|timeout'
```

Likely owners:

- route or firewall;
- load balancer target;
- service listener;
- SYN backlog or accept queue;
- packet loss before connection establishment.

### High first-byte time

Strong signals:

- connect/TLS are normal;
- curl `time_starttransfer` is high;
- NGINX `$upstream_header_time` is high;
- app logs show handler or dependency delay;
- queue depth or worker saturation rises.

Likely owners:

- application handler;
- proxy queue;
- database/cache/downstream API;
- thread/worker pool;
- retry storm or dependency fan-out.

Do not send a high first-byte incident to the network team until proxy and application timing are checked.

## Add Proxy Timing

For Nginx, include upstream timing fields:

```nginx
log_format upstream_timing
  '$remote_addr request_id=$request_id '
  '"$request" status=$status bytes=$body_bytes_sent '
  'rt=$request_time '
  'uaddr="$upstream_addr" ustatus="$upstream_status" '
  'uct="$upstream_connect_time" uht="$upstream_header_time" urt="$upstream_response_time" '
  'host="$host" uri="$request_uri"';

access_log /var/log/nginx/access.log upstream_timing;
```

Interpretation:

- high `$upstream_connect_time`: Nginx-to-upstream connection path or listener issue;
- high `$upstream_header_time`: upstream app or dependency slow before headers;
- high `$upstream_response_time`: body generation or transfer slow;
- high `$request_time` with low upstream times: downstream/client path may be slow.

This turns "latency is high" into a specific layer.

## Packet Capture When Logs Disagree

Use packet capture to prove direction and timing:

```bash
tcpdump -tttt -nn -i any host <peer-ip> and port <port>
```

For serious incidents, capture near both ends:

```bash
# source side
tcpdump -tttt -nn -i any host <destination-ip> and port <port> -w source.pcap

# destination side
tcpdump -tttt -nn -i any host <source-ip> and port <port> -w destination.pcap
```

Two-sided capture can separate:

- packet leaves source but never reaches destination: forward-path loss;
- packet reaches destination but ACK/response does not return: return-path issue;
- packets arrive late in bursts: queueing or buffering;
- receiver sees packets but application responds late: host/app pressure;
- one-sided capture missed packets due to capture placement or offload.

One pcap is a clue. Two synchronized captures are evidence.

## Case 1: Real Path Latency

Strong signals:

- RTT is high to the final destination;
- connect time is high from multiple clients;
- `mtr` destination latency rises during impact window;
- packet capture confirms delayed packets;
- app first-byte time is not the primary contributor.

Fix path:

- compare source regions, routes, VPN paths, and provider paths;
- test affected and unaffected clients;
- collect timestamps, source, destination, protocol, and application impact;
- escalate with evidence from the bad window.

Provider escalations work better with concrete pairs and timestamps than with "network is slow."

## Case 2: Packet Loss Or Retransmissions

Strong signals:

- retransmission counters rise during the bad window;
- `ss -ti` shows retransmission state or rising RTT/RTO;
- packet capture shows missing data or ACKs;
- latency spikes correlate with timeout rate;
- one endpoint/path is consistently worse.

Fix path:

- check interface and virtual network drops;
- compare source and destination captures;
- check congestion and queue pressure;
- reduce burst traffic or retry amplification;
- remove a bad node/path from rotation when possible.

Retransmission is a symptom. The root may be path loss, ACK loss, congestion, receiver pressure, or capture placement.

## Case 3: Receiver Or Host Pressure

Strong signals:

- network path tests are acceptable;
- server CPU/softirq/worker pool is saturated;
- receive/send queues grow;
- app runtime has GC pauses, locks, or thread starvation;
- first-byte time rises with host pressure.

Fix path:

- inspect CPU, softirq, NIC counters, and socket queues;
- profile the application runtime;
- reduce blocking in request handlers;
- add backpressure instead of unbounded queues;
- scale only after proving where the queue forms.

Receiver pressure can make the network look slow because packets are processed late or responses are generated late.

## Case 4: Application Or Dependency Latency

Strong signals:

- connect/TLS normal;
- first byte high;
- NGINX upstream header time high;
- app handler logs show DB/cache/API waits;
- p95/p99 latency rises with dependency latency, not with RTT.

Fix path:

- add per-dependency timing;
- separate queue wait from handler execution;
- set dependency deadlines below handler deadlines;
- reduce fan-out and retry storms;
- use caching, pagination, async jobs, or load shedding when appropriate.

This is the branch where "network latency" is a misleading label.

## Case 5: Slow Response Body

Strong signals:

- first byte is normal;
- total time is high;
- large downloads, reports, exports, or streams dominate;
- body transfer has long gaps;
- client or proxy idle timeout appears.

Fix path:

- inspect response size and chunk timing;
- use pagination or resumable downloads;
- move long exports to background jobs;
- align stream heartbeat and idle timeout behavior;
- propagate cancellation when the caller disconnects.

High total time with normal first byte is not connect latency.

## Case 6: One Backend Or Region Is Slow

Strong signals:

- curl `remote_ip` differs between fast and slow requests;
- one Nginx `$upstream_addr` has higher timings;
- only one region/subnet/client group is affected;
- one node has retransmissions, CPU pressure, or dependency waits.

Test individual targets while preserving hostname/SNI:

```bash
curl -v \
  --resolve example.com:443:203.0.113.10 \
  https://example.com/path
```

Fix path:

- compare bad and healthy targets;
- drain the bad target if user impact is active;
- inspect deploy version, counters, logs, and dependency path;
- keep evidence before restarting or replacing the node.

Averages hide this class of issue. Look at per-target p95/p99.

## Timeout Budgeting

High latency becomes outages when timeouts are not layered.

Example shape for a normal API:

```text
database/API timeout:         2s
application handler deadline: 3s
reverse proxy timeout:        5s
external client timeout:      10s
```

These numbers are examples. The useful properties are:

- dependencies fail before the app deadline;
- the app returns a controlled error before the proxy/client gives up;
- retries fit inside one caller deadline;
- long-running jobs have explicit async/export flows;
- timeout changes are based on measured phase latency.

If every layer waits 30 seconds, the wrong layer often reports the symptom and expensive work continues after callers leave.

## What Not To Do

- Do not use `ping` alone to prove or disprove application latency.
- Do not blame the network when connect/TLS are fast and first byte is slow.
- Do not rely on one clean sample after the incident.
- Do not treat middle-hop `mtr` loss as forwarding loss if later hops are clean.
- Do not tune kernel or TCP settings before proving packet loss, queueing, or host pressure.
- Do not compare laptop tests with production private-network paths without noting the difference.
- Do not use averages; inspect p95, p99, and per-target outliers.

## Decision Tree

```text
high latency reported
|
+-- curl dns high?
|   |
|   +-- inspect resolver, service discovery, search domains
|
+-- curl connect high?
|   |
|   +-- inspect route, firewall, listener, accept queue, SYN retransmits
|
+-- curl tls high?
|   |
|   +-- inspect SNI, certificate chain, TLS terminator load
|
+-- first_byte high but connect/TLS normal?
|   |
|   +-- inspect proxy queue, app handler, dependencies
|
+-- total high but first_byte normal?
|   |
|   +-- inspect response body, streaming, slow client path
|
+-- retransmissions or packet loss rise?
|   |
|   +-- inspect path loss, congestion, receiver pressure, bad endpoint
|
+-- only one remote_ip/upstream_addr slow?
    |
    +-- inspect that node/path/region specifically
```

## Minimal Incident Note Template

```text
Symptom:
- user impact:
- affected route:
- source region/subnet:
- destination hostname/IP:
- time window:

Client timing:
- remote_ip:
- dns:
- connect:
- tls:
- first_byte:
- total:
- sample count:

Proxy/app timing:
- request_id:
- upstream_addr:
- request_time:
- upstream_connect_time:
- upstream_header_time:
- upstream_response_time:
- app handler time:
- dependency timings:

Network evidence:
- ping/mtr destination result:
- retransmission delta:
- ss -ti sample:
- interface drops/errors:
- packet capture:

Hypothesis:
- slow component:
- evidence:

Fix:
- code/config/network/capacity change:
- validation:
```

The incident is solved when "latency" is no longer a vague label. It should resolve to a component: DNS, connect, TLS, first byte, body transfer, retransmission, host queueing, or dependency time.

## References

- [curl man page: write-out timing variables](https://curl.se/docs/manpage.html)
- [NGINX logging guide and upstream timing variables](https://docs.nginx.com/nginx/admin-guide/monitoring/logging/)
- [Linux `tcp(7)` manual page](https://man7.org/linux/man-pages/man7/tcp.7.html)
- [Linux `ss(8)` manual page](https://man7.org/linux/man-pages/man8/ss.8.html)
- [tcpdump manual page](https://www.tcpdump.org/manpages/tcpdump.1.html)
- [RFC 9293: Transmission Control Protocol](https://www.rfc-editor.org/rfc/rfc9293)
