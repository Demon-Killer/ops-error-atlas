---
title: How to debug intermittent packet loss
description: A practical guide to intermittent packet loss that explains how to prove timing, direction, path, host counters, queue drops, and application impact.
slug: intermittent-packet-loss
publishedAt: 2026-05-03
updatedAt: 2026-05-29
tags:
  - networking
  - packet-loss
  - Linux
related:
  - tcp-retransmissions
  - high-network-latency
  - io-timeout
  - read-connection-timed-out
---

Intermittent packet loss is hard because the path is healthy part of the time. A single clean `ping` proves almost nothing. A single `mtr` line with loss at a middle hop may also prove almost nothing. You need to prove the time window, direction, path, traffic class, host counters, and application impact.

The useful question is:

```text
Which packets were lost, in which direction, on which path, during which time window, and did that loss correlate with user-visible latency or timeouts?
```

Until you can answer that, "packet loss" is a suspicion, not a diagnosis.

## Define The Incident Before Running Tools

Write the scope first:

```text
source IP/subnet:
destination IP/subnet:
protocol and port:
application route:
time window:
failure rate:
affected clients/regions:
unaffected clients/regions:
application symptom:
```

This matters because loss is path-specific. Loss from your laptop to an edge host does not prove loss from a production pod to a database. ICMP（Internet Control Message Protocol，用于 ping/mtr 的控制报文）loss does not automatically prove TCP（Transmission Control Protocol，传输控制协议）application loss. A clean ping does not prove HTTPS, database, or service-mesh traffic is healthy.

## What Intermittent Loss Can Mean

Packets may disappear or be delayed in several places:

| Location | What drops or delays packets | First evidence |
| --- | --- | --- |
| Source host | NIC queue, veth, bridge, CNI, firewall, conntrack, CPU/softirq pressure | `ip -s link`, `ethtool -S`, `/proc/softirqs`, host CPU |
| Forward path | provider route, VPN, firewall, NAT, load balancer, congested link | two-sided capture, `mtr`, retransmission deltas |
| Destination host | receive queue, app not reading, CPU/softirq, NIC drops | `ss -ti`, receive queue, app runtime metrics |
| Return path | ACK or response packets lost on the way back | source sees retransmits, destination saw original data |
| Middle appliance | firewall/NAT/VPN rate limit or state pressure | flow logs, conntrack/NAT metrics, path-specific failures |
| Traffic class | only one port/protocol/QoS class affected | app traffic fails while ICMP is clean, or reverse |

The provider network is only one branch.

## Fast Triage Order

1. Pin down the affected source/destination/protocol/time window.
2. Compare affected and unaffected paths.
3. Check application impact: latency p95/p99, timeout rate, retry rate, error rate.
4. Check TCP retransmission deltas during the same window.
5. Check host and interface counters before blaming the path.
6. Capture packets near both ends if the direction is unclear.
7. Escalate only with source, destination, port, timestamps, and evidence.

The fastest path to a wrong conclusion is running one command from the wrong network and generalizing from it.

## Start With Repeated Measurements, Not One Snapshot

Basic tests:

```bash
ping -c 200 <host>
mtr -rw <host>
```

These are signals, not final proof. ICMP behavior can differ from application traffic.

For time-series evidence:

```bash
for i in $(seq 1 60); do
  date -Is
  ping -c 5 <host> | tail -2
  sleep 10
done
```

This is crude but useful for short bursts. If the issue is tied to traffic peaks, run the measurement during the bad window, not after.

For application traffic, prefer a protocol-specific check:

```bash
for i in $(seq 1 30); do
  date -Is
  curl -sS -o /dev/null \
    -w "$i remote_ip=%{remote_ip} connect=%{time_connect} first_byte=%{time_starttransfer} total=%{time_total}\n" \
    https://example.com/path
done
```

If `ping` is clean but application connect or first-byte timing spikes, do not stop. The loss may affect a specific port, route, proxy path, or overloaded receiver.

## Read mtr Without Overreacting

`mtr` is useful, but intermediate routers may rate-limit ICMP replies to themselves. That can look like loss even when forwarding is fine.

More credible pattern:

```text
loss appears at hop N
similar or worse loss continues to later hops
destination also shows loss or latency
application errors rise in the same window
```

Less credible pattern:

```text
one middle hop shows loss
later hops and destination are clean
application traffic is healthy
```

Do not open a provider escalation with only a middle-hop loss line. Include destination impact and application symptoms.

## Check TCP Retransmission Deltas

TCP retransmissions are often stronger evidence than ICMP loss, especially for application traffic.

```bash
netstat -s | grep -Ei 'retrans|timeout|segments retrans'
sar -n TCP,ETCP 1 10
ss -ti dst <peer-ip>
```

Read counters as deltas. A cumulative counter that is high since boot is less useful than a counter that increases during the user-impact window.

Useful signals:

| Signal | Interpretation |
| --- | --- |
| retransmissions rise with timeout rate | loss, congestion, ACK loss, or receiver pressure is affecting users |
| RTT rises before retransmissions | queueing or congestion before loss recovery |
| one peer has worse `ss -ti` stats | path, endpoint, or node-specific issue |
| send queue does not drain | receiver or path backpressure |
| retransmissions rise with CPU/softirq pressure | host may be processing packets late |

Retransmission still does not prove provider loss by itself. It proves the sender had to send data again.

## Inspect Interface And Host Counters

On Linux:

```bash
ip -s link
ip -s link show <interface>
ethtool -S <interface>
cat /proc/softirqs
mpstat -P ALL 1 5
vmstat 1 5
```

Look for counters that increase during the incident:

- `rx_dropped`;
- `tx_dropped`;
- `rx_errors`;
- `tx_errors`;
- CRC/frame errors;
- driver queue drops;
- virtual interface or bridge drops;
- softirq imbalance or saturation.

Read twice:

```bash
date -Is
ip -s link show <interface>
sleep 60
date -Is
ip -s link show <interface>
```

If counters increase during the bad window, you have local evidence. If counters are high but flat, they may be historical.

## Virtualized And Container Paths Matter

A clean physical NIC does not rule out drops inside:

- veth pairs;
- Linux bridges;
- overlay networks;
- CNI datapaths;
- service mesh sidecars;
- conntrack/NAT tables;
- host firewalls;
- virtual NIC queues;
- cloud load balancer targets.

For Kubernetes, also inspect pod/node placement and whether only one node, CNI path, or sidecar version is affected. The exact commands depend on the environment, but the principle is stable: prove where packets stop or queue before changing app timeouts.

## Two-Sided Capture Is The Strongest Simple Proof

One packet capture shows what one machine saw. It does not prove what the other machine received.

Focused capture:

```bash
tcpdump -tttt -nn -i any host <peer-ip> and port <port>
```

Two-sided capture:

```bash
# source side
tcpdump -tttt -nn -i any host <destination-ip> and port <port> -w source.pcap

# destination side
tcpdump -tttt -nn -i any host <source-ip> and port <port> -w destination.pcap
```

Interpretation:

| Source capture | Destination capture | Stronger conclusion |
| --- | --- | --- |
| packet leaves source, never arrives | absent | forward-path loss between capture points |
| packet arrives at destination, ACK/response missing at source | present | return-path loss, ACK loss, firewall/NAT, or response-side issue |
| packet never leaves source | absent | source host, firewall, queue, or application did not send |
| packet arrives late in bursts | present late | queueing, buffering, congestion, or receiver pressure |
| destination receives original, source retransmits | present | ACK path loss, capture placement, or timing/capture artifact |

Synchronize clocks when possible. Without timestamps from both ends, direction claims are weaker.

## Case 1: Real Forward-Path Loss

Strong signals:

- source capture shows packets leaving;
- destination capture does not show them;
- retransmissions rise at the source;
- application timeouts or latency rise in the same window;
- issue is path-specific, not global.

Fix path:

- compare affected and unaffected routes;
- check local interface and virtual network counters first;
- check firewall/NAT/VPN/load balancer paths;
- escalate with source, destination, protocol, port, and UTC timestamps;
- include packet capture evidence and application impact.

Provider escalations need concrete flow evidence. "mtr shows loss" is usually not enough.

## Case 2: Return-Path Or ACK Loss

Strong signals:

- destination receives original data;
- source retransmits because ACK or response does not arrive;
- destination-side capture shows ACK/response leaving;
- source-side capture does not see it;
- only one direction or asymmetric path is affected.

Fix path:

- compare route in both directions;
- inspect firewalls, NAT, VPN, service mesh, and routing policies;
- check stateful middleboxes for table pressure or asymmetric routing;
- collect captures on both sides of the suspected middlebox if possible.

Return-path loss is easy to miss if you only capture on the sender.

## Case 3: Host Or Interface Drops

Strong signals:

- `ip -s link` or `ethtool -S` counters increase during the incident;
- drops are isolated to one node or interface;
- softirq or CPU pressure rises with loss;
- application traffic on that host shows timeouts while other hosts are fine.

Fix path:

- inspect NIC, driver, queue, offload, cable/switch port if physical;
- inspect veth/bridge/CNI path if virtualized;
- check interrupt distribution and CPU saturation;
- reduce burst pressure or add capacity where the queue forms;
- validate under comparable traffic.

Do not reset or replace the host before capturing counter deltas if you need root cause.

## Case 4: Congestion Or Queue Drops Under Bursts

Strong signals:

- loss appears only during batch jobs, backups, deploys, traffic spikes, or retry storms;
- throughput rises before loss;
- latency rises before packet loss;
- queue or drop counters rise;
- retries amplify the incident.

Fix path:

- reduce burst size;
- shape traffic closer to the source;
- add capacity at the bottleneck queue;
- bound retries with backoff and jitter;
- use load shedding instead of allowing all callers to queue until timeout.

Burst loss is often fixed by smoothing traffic before it reaches the constrained queue, not by increasing application retries.

## Case 5: Receiver Pressure Looks Like Loss

Strong signals:

- packets arrive at destination;
- application responds slowly or stops reading;
- receive queues grow;
- CPU, GC, locks, disk, or downstream dependencies are saturated;
- retransmissions correlate with receiver-side application latency.

Checks:

```bash
ss -tanp | grep '<process>'
ss -tinp | grep '<peer-ip>'
top
pidstat -u 1 5
pidstat -d 1 5
```

Fix path:

- profile the receiving application;
- fix blocked read loops or slow response writers;
- reduce downstream blocking;
- add backpressure;
- scale workers only after proving the bottleneck.

An overloaded receiver can make TCP behave badly even when the network path is not dropping packets.

## Case 6: ICMP Loss But Application Traffic Is Fine

Strong signals:

- `mtr` or ping shows loss at an intermediate hop;
- destination has no loss;
- TCP retransmissions do not rise;
- application latency and timeout rate are stable;
- only ICMP is affected.

Response:

- document it as ICMP rate limiting unless proven otherwise;
- avoid noisy alerts based only on middle-hop ICMP loss;
- monitor destination and application traffic instead.

This avoids chasing harmless router behavior.

## Application Impact Checklist

Packet loss matters operationally when it changes user-visible behavior. Correlate packet evidence with:

- request latency p95/p99;
- timeout rate;
- retry rate;
- TCP retransmission deltas;
- upstream saturation;
- queue depth;
- regional error distribution;
- affected endpoints or clients;
- deploy/batch/traffic events.

This is how you avoid debugging harmless ICMP noise while ignoring real service degradation.

## What Not To Do

- Do not rely on one ping result.
- Do not assume no ICMP loss means no application packet loss.
- Do not assume ICMP loss at one middle hop means forwarding loss.
- Do not ignore host, virtual interface, CNI, NAT, and receiver counters.
- Do not escalate to a provider without source, destination, port, timestamp, and application impact.
- Do not increase retries during a loss burst without a total deadline and backoff.
- Do not restart the suspected node before capturing counter deltas when root cause matters.

## Decision Tree

```text
intermittent packet loss suspected
|
+-- application latency/timeouts also increased?
|   |
|   +-- no: treat packet signal as low priority until correlated
|
+-- ICMP loss only at middle hop, destination clean?
|   |
|   +-- likely ICMP rate limiting; verify app/TCP metrics
|
+-- retransmission counters rise during incident?
|   |
|   +-- inspect source/destination sockets, path, receiver pressure
|
+-- interface or virtual network drops increase?
|   |
|   +-- inspect host/NIC/veth/bridge/CNI/softirq queue
|
+-- two-sided capture shows packet leaves source but not destination?
|   |
|   +-- forward-path loss between capture points
|
+-- destination receives data but source retransmits?
|   |
|   +-- return-path/ACK loss, capture placement, or receiver delay
|
+-- loss only during bursts?
    |
    +-- inspect congestion, queue drops, batch jobs, retry amplification
```

## Minimal Incident Note Template

```text
Symptom:
- time window:
- source IP/subnet:
- destination IP/subnet:
- protocol/port:
- affected application route:
- user impact:

Application evidence:
- latency p95/p99:
- timeout rate:
- retry rate:
- affected clients/regions:

Network evidence:
- ping/mtr destination result:
- TCP retransmission delta:
- ss -ti sample:
- source interface counters before/after:
- destination interface counters before/after:
- virtual network/CNI/NAT counters:
- source-side pcap:
- destination-side pcap:

Direction:
- forward path loss:
- return path loss:
- host/local queue:
- receiver pressure:

Hypothesis:
- suspected drop point:
- evidence:

Fix:
- network/config/capacity/app change:
- validation:
```

The incident is understood when packet loss is tied to a specific flow, direction, time window, and application impact.

## References

- [Linux `ip-link(8)` manual page](https://man7.org/linux/man-pages/man8/ip-link.8.html)
- [Linux `tcp(7)` manual page](https://man7.org/linux/man-pages/man7/tcp.7.html)
- [Linux `ss(8)` manual page](https://man7.org/linux/man-pages/man8/ss.8.html)
- [tcpdump manual page](https://www.tcpdump.org/manpages/tcpdump.1.html)
- [RFC 9293: Transmission Control Protocol](https://www.rfc-editor.org/rfc/rfc9293)
- [RFC 5681: TCP Congestion Control](https://www.rfc-editor.org/rfc/rfc5681)
