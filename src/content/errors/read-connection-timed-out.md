---
title: 'Why "read: connection timed out" happens'
description: A practical read timeout guide that separates established connections, first-byte delay, stalled response bodies, packet loss, proxy idle timeouts, and upstream dependency latency.
slug: read-connection-timed-out
publishedAt: 2026-05-04
updatedAt: 2026-05-29
tags:
  - timeout
  - TCP
  - Linux
related:
  - io-timeout
  - curl-28-operation-timed-out
  - high-network-latency
  - tcp-retransmissions
---

`read: connection timed out` usually means the connection was already established, but the next expected bytes did not arrive before the read deadline. It is different from DNS failure, TCP connect failure, and TLS handshake failure. The socket exists; the read operation waited too long.

That distinction matters because a read timeout can happen in two very different places:

```text
DNS -> TCP connect -> TLS -> request write -> first response byte -> response body
                                           ^                      ^
                                           |                      |
                                      read before headers     read during body
```

The useful question is:

```text
Did the timeout happen before the first response byte, or after the response started?
```

If you cannot answer that, you are not ready to change timeout settings.

## What a read timeout proves

A read timeout proves:

- the caller was waiting for data from an established connection;
- no acceptable data arrived before the read deadline;
- the symptom happened after at least some earlier phase succeeded.

It does not prove:

- the network is the root cause;
- the remote application is down;
- the server received the request;
- the response would never have arrived;
- increasing the read timeout is safe.

A read timeout can be caused by a slow upstream handler, a blocked database, a response stream that goes silent, packet loss, a proxy idle timeout, or a timeout budget that lets the caller give up before the server path finishes.

## Place it on the request timeline

Use this timeline for HTTP and similar request/response protocols:

```text
client starts request
  -> DNS resolved
  -> TCP connected
  -> TLS completed
  -> request fully written
  -> first response byte received
  -> response body completed
```

Then classify the read timeout:

| Timeout location | What it usually means | First branch |
| --- | --- | --- |
| Before first byte | server/proxy accepted the connection but did not start a response in time | upstream handler, queueing, DB/cache/API dependency, proxy routing |
| Between body chunks | response started but stopped making progress | streaming bug, large export, proxy idle timeout, packet loss |
| At an exact repeated duration | configured read/idle timeout boundary | client, proxy, load balancer, server timeout budget |
| Only on one endpoint | endpoint-specific code or dependency | handler timing, response size, query pattern |
| Only on one remote IP | bad backend, route, node, or path | per-target tests, packet loss, host pressure |
| Under load only | saturation or queueing | worker pool, connection pool, CPU throttling, database locks |

The owner changes by location. A first-byte timeout is usually not the same incident as a body-stream stall.

## Measure first byte separately from total time

Start with curl timing:

```bash
curl -sS -o /dev/null \
  -w 'remote_ip=%{remote_ip} connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
  https://example.com/path
```

curl timing fields are cumulative from the start of the transfer. Read them like this:

- `time_connect` tells you whether TCP connect completed quickly.
- `time_appconnect` tells you whether TLS completed quickly for HTTPS.
- `time_starttransfer` tells you when the first response byte arrived.
- `time_total` tells you when the whole transfer completed.

Interpretation:

| Observation | Likely branch |
| --- | --- |
| connect/TLS fast, first byte high | upstream app, proxy, or dependency latency |
| first byte normal, total high | response body transfer or streaming stall |
| one `remote_ip` slow | bad backend, route, edge, or node |
| repeated timeout duration | configured read or idle timeout |
| intermittent long gaps | packet loss, saturation, or stream pause |

Repeat the test. One clean request does not disprove intermittent read timeouts.

```bash
for i in $(seq 1 10); do
  date -Is
  curl -sS -o /dev/null \
    -w "$i remote_ip=%{remote_ip} connect=%{time_connect} first_byte=%{time_starttransfer} total=%{time_total}\n" \
    https://example.com/path
done
```

## Compare client timing with proxy and app timing

Client timing alone identifies the slow phase from the caller's point of view. It does not identify the owner.

For Nginx, log upstream timing:

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

Use the fields this way:

- `$upstream_connect_time` high means Nginx struggled to connect to upstream.
- `$upstream_header_time` high means upstream took too long to produce headers.
- `$upstream_response_time` high with normal header time means body transfer or body generation is slow.
- `$request_time` high with low upstream times means downstream/client transfer path may be slow.

Now compare:

| Client view | Nginx/app view | Interpretation |
| --- | --- | --- |
| first byte high | upstream header time high | app/dependency latency before headers |
| first byte high | no upstream log | request may not reach app; inspect routing/proxy layer |
| total high | upstream response time high | upstream body generation or stream issue |
| total high | upstream response time low | downstream/client path or response send issue |
| client timeout | app finishes after timeout | timeout budget too short or app missing cancellation |

## Packet evidence: prove silence vs retransmission

When logs do not explain the wait, capture packets:

```bash
tcpdump -tttt -nn -i any host <peer-ip> and port <port>
ss -ti dst <peer-ip>
netstat -s | grep -Ei 'retrans|timeout|reset'
```

Packet-level patterns:

| Packet pattern | Meaning | First branch |
| --- | --- | --- |
| no response packets after request | server/proxy/app did not send data or packet path broke | server logs, routing, firewall, packet loss |
| repeated retransmissions | packets lost or not acknowledged | network path, receiver pressure, interface drops |
| `RST` from peer | peer aborted connection | app/proxy reset, deploy, protocol error |
| `FIN` from peer | peer closed gracefully | normal close, idle close, end-of-stream mismatch |
| data arrives after caller timeout | timeout budget too short or app too slow | deadline alignment, cancellation |

For TLS traffic, packet capture will not show HTTP content, but it still shows timing, retransmissions, and close direction.

## Case 1: Slow first byte

Strong signals:

- TCP connect and TLS are quick;
- `time_starttransfer` is high;
- server logs show the request started but response headers were delayed;
- Nginx `$upstream_header_time` is high;
- app dependency logs show database/cache/API latency.

Likely causes:

- slow database query or lock wait;
- cache outage causing slow fallback;
- external API call without a shorter deadline;
- request queueing before a worker handles it;
- CPU-bound handler or event-loop blocking;
- retry storm inside the server path.

Fix path:

1. Add per-dependency timing inside the handler.
2. Log queue wait separately from handler execution.
3. Set dependency deadlines below the handler deadline.
4. Return a controlled error before the caller read deadline fires.
5. Reduce fan-out, paginate, cache safely, or move long work async.

Do not call this "network timeout" until app and proxy timing are ruled out.

## Case 2: Response body starts, then stalls

Strong signals:

- first byte is fast but total time is high;
- response headers arrive before the timeout;
- `body_bytes_sent` or client bytes read is nonzero;
- large exports, downloads, reports, or streaming endpoints dominate;
- long gaps appear between chunks.

Likely causes:

- streaming generator stalls;
- export code pauses while scanning database pages;
- proxy read/idle timeout closes silent streams;
- object storage or file backend stalls mid-transfer;
- client cancellation is not propagated to upstream work.

Fix path:

- log chunk timing and body generation phases;
- avoid committing success headers before the operation has passed its main failure point;
- use background jobs and downloadable artifacts for long exports;
- use pagination or resumable downloads where appropriate;
- make stream heartbeat behavior explicit if the protocol supports it;
- align read/idle timeouts across client, proxy, load balancer, and app.

Read timeout during body transfer is a product and protocol design problem as much as a timeout setting.

## Case 3: Packet loss or retransmissions

Strong signals:

- `ss -ti` shows retransmission or high retrans counters;
- `netstat -s` retransmission counters rise during the incident;
- packet capture shows data or ACK retransmissions;
- failures are intermittent and path-specific;
- only one node, subnet, region, or remote IP is affected.

Fix path:

- compare packet captures from both ends if possible;
- check interface drops, MTU problems, congestion, and bad routes;
- compare healthy and unhealthy paths;
- remove a bad endpoint from rotation while preserving evidence;
- avoid masking real packet loss by only increasing read deadlines.

Retransmissions can make bytes arrive after the application deadline even when the server eventually responds.

## Case 4: Proxy or firewall idle timeout

Strong signals:

- failures happen at an exact idle duration;
- long-running streams go silent before failure;
- response body starts, then no bytes arrive for the proxy idle window;
- a load balancer, firewall, service mesh, or Nginx sits between client and server.

Fix path:

- identify every hop's idle timeout;
- compare client read timeout, proxy read/idle timeout, load balancer timeout, and app stream behavior;
- send protocol-appropriate heartbeat chunks only when correct;
- avoid silent long-running operations behind request/response endpoints;
- prefer async job + polling/download for long work.

A proxy idle timeout is about lack of progress, not total job duration. A long job that emits no bytes can be killed while a longer stream that emits periodic bytes survives.

## Case 5: Server keeps working after caller timed out

Strong signals:

- client logs read timeout;
- app logs show the request finishes later;
- database query continues after caller cancellation;
- Nginx logs `499 Client Closed Request` near the same route;
- upstream CPU/DB load remains high after client aborts.

Fix path:

- propagate cancellation from client/request context to downstream dependencies;
- set dependency deadlines below caller deadlines;
- stop expensive work when the caller has gone away unless the workflow explicitly requires completion;
- use idempotency keys for operations that may be retried;
- move long work to background jobs when completion should not depend on a live socket.

This is where read timeouts become capacity problems: the user is gone, but the system keeps spending resources.

## Case 6: One backend or remote IP is slow

Strong signals:

- curl `remote_ip` differs between fast and slow runs;
- `--resolve` to one IP reproduces the timeout;
- only one upstream address appears in proxy logs;
- one node has high CPU, packet loss, restarts, or dependency latency.

Test one target while preserving hostname/SNI:

```bash
curl -v \
  --resolve example.com:443:203.0.113.10 \
  https://example.com/path
```

Fix path:

- compare bad and healthy nodes;
- drain the bad node if it harms traffic;
- check deploy version, CPU, memory, network counters, dependency latency, and logs;
- preserve evidence before replacing the instance.

Do not average all backends together. One sick node can create intermittent read timeouts.

## Timeout budgeting

Read deadlines should fit into a layered request budget.

Example shape for a normal API:

```text
database/API dependency timeout: 2s
application handler deadline:    3s
reverse proxy read timeout:      5s
external client timeout:         10s
```

These values are examples. The important properties are:

- dependencies fail before the handler deadline;
- the app returns a controlled error before proxy/client read timeouts;
- long-running endpoints have separate contracts;
- retries fit inside the same caller deadline;
- cancellation stops work that can no longer produce a response.

If every layer waits 30 seconds, the wrong layer will report the symptom and the system may waste work after callers give up.

## What not to do

- Do not debug read timeout with `ping` as primary evidence.
- Do not raise read deadlines before separating first-byte delay from body stall.
- Do not ignore upstream work that continues after the client timed out.
- Do not retry unsafe writes if the server may still be processing the first request.
- Do not test only from a laptop when production runs in a private network, pod, or service mesh.
- Do not treat one successful request as proof that intermittent read timeouts are gone.

## Decision tree

```text
read: connection timed out
|
+-- TCP connect/TLS are slow?
|   |
|   +-- not a pure read-timeout branch; debug connect/TLS first
|
+-- first byte is slow?
|   |
|   +-- inspect upstream handler, queueing, DB/cache/API latency
|
+-- first byte arrives but total stalls?
|   |
|   +-- inspect streaming, body generation, proxy idle timeout, packet gaps
|
+-- retransmissions increase during wait?
|   |
|   +-- inspect packet loss, receiver pressure, route, bad endpoint
|
+-- app finishes after client timeout?
|   |
|   +-- fix timeout budget and cancellation propagation
|
+-- only one remote_ip fails?
    |
    +-- inspect that backend/node/path specifically
```

## Minimal incident note template

```text
Symptom:
- error text:
- caller:
- dependency:
- route:
- first seen:

Client timing:
- remote_ip:
- connect:
- tls:
- first_byte:
- total:
- read deadline:

Proxy/app timing:
- request_id:
- Nginx request_time:
- upstream_connect_time:
- upstream_header_time:
- upstream_response_time:
- app handler time:
- dependency timings:

Packet evidence:
- retransmissions:
- packet gap:
- FIN/RST:
- affected path/node:

Hypothesis:
- first-byte delay or body stall:
- evidence:

Fix:
- code/config/capacity change:
- validation command:
```

The goal is to make the next read timeout automatically classifiable: first byte, body stall, packet loss, proxy idle, or timeout budget mismatch.

## References

- [curl man page: write-out timing variables](https://curl.se/docs/manpage.html)
- [NGINX logging guide and upstream timing variables](https://docs.nginx.com/nginx/admin-guide/monitoring/logging/)
- [NGINX `proxy_read_timeout` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout)
- [Linux `tcp(7)` manual page](https://man7.org/linux/man-pages/man7/tcp.7.html)
- [Linux `ss(8)` manual page](https://man7.org/linux/man-pages/man8/ss.8.html)
- [tcpdump manual page](https://www.tcpdump.org/manpages/tcpdump.1.html)
