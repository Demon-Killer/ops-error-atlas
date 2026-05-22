---
title: What causes TCP retransmissions
description: A practical TCP retransmission guide that separates packet loss, congestion, receiver pressure, reordering, bad links, and misleading one-sided packet captures.
slug: tcp-retransmissions
publishedAt: 2026-05-06
updatedAt: 2026-05-22
tags:
  - TCP
  - networking
  - latency
related:
  - intermittent-packet-loss
  - high-network-latency
  - connection-reset-by-peer
  - io-timeout
---

TCP retransmissions happen when a TCP sender sends data again because the original data, or the acknowledgment for that data, was not processed in the expected way. They are a reliability mechanism, not a diagnosis by themselves.

The mistake is to read "TCP retransmission" as "the network provider dropped packets." That may be true, but it is only one branch. Retransmissions can also be caused by congestion, receiver pressure, packet reordering, ACK path loss, bad capture placement, overloaded hosts, or one-sided packet evidence.

The useful question is:

```text
Which side retransmitted, what was missing from that side's view, and does it correlate with user-visible latency or timeouts?
```

## What TCP guarantees

Linux `tcp(7)` describes TCP as a reliable, stream-oriented, full-duplex connection and notes that TCP retransmits lost packets. RFC 9293 defines TCP's core behavior around sequence numbers, acknowledgments, retransmission, and reliable delivery. RFC 5681 describes congestion control behavior including duplicate acknowledgments and fast retransmit.

That matters because retransmission is expected behavior in TCP. The presence of a retransmission does not automatically mean the network is broken. The question is whether retransmissions increased during the same window as user-visible latency, throughput collapse, or application timeouts.

## A realistic incident shape

This is an example scenario, not a claim about every network issue.

An API starts timing out between one application cluster and one database cluster. A packet analyzer labels many packets:

```text
TCP Retransmission
TCP Dup ACK
TCP Out-Of-Order
```

The weak conclusion is:

```text
The network is dropping packets.
```

The stronger investigation asks:

```text
Did the destination actually miss the original data?
Did the ACK return path fail?
Did the receiver delay reading?
Did the capture point miss packets?
Did retransmissions increase at the same time as application latency?
```

Without those answers, retransmission labels are clues, not proof.

## First decide whether retransmissions matter

Before escalating, define the incident:

```text
time window:
source IP and port:
destination IP and port:
application symptom:
latency or timeout impact:
retransmission counter delta:
affected region / node / path:
traffic level during incident:
```

Use measured deltas. Counters that have accumulated since boot are not enough.

## First diagnostic commands

Check TCP counters over time:

```bash
netstat -s | grep -Ei 'retrans|timeout|segments retrans'
sar -n TCP,ETCP 1 10
```

`netstat -s` shows cumulative protocol counters. `sar` can sample TCP and error counters over time if sysstat is installed.

Inspect active sockets:

```bash
ss -ti
ss -ti dst <peer-ip>
```

The `ss(8)` manual describes `ss` as a tool for dumping socket statistics. With TCP sockets, `ss -i` can expose internal TCP information such as retransmission-related state, congestion window, RTT, and delivery-rate details depending on kernel support.

Check interface counters:

```bash
ip -s link
ethtool -S <interface>
```

Check host pressure:

```bash
top
vmstat 1 5
mpstat -P ALL 1 5
cat /proc/softirqs
```

Host CPU, softirq pressure, and receiver scheduling can change TCP behavior even when the physical network path is healthy.

## Read `ss -ti` carefully

Example output varies by kernel and iproute2 version, but useful fields often include:

```text
rtt
rto
cwnd
ssthresh
bytes_sent
bytes_retrans
retrans
send
delivery_rate
```

Interpretation:

| Signal | What it suggests |
| --- | --- |
| retrans count rises during incident | sender believes data or ACKs are missing |
| RTT rises before retransmissions | queueing, congestion, or receiver delay |
| send queue does not drain | receiver, path, or application backpressure |
| congestion window shrinks | TCP congestion response or loss recovery |
| one peer shows worse stats than others | path, host, or endpoint-specific issue |

These are signals, not final causes. Confirm with counters, packet captures, and application timing.

## Packet capture: one side is not enough

Start with a focused capture:

```bash
tcpdump -tttt -nn -i any host <peer-ip> and port <port>
```

`tcpdump` captures packets visible at the chosen interface. It does not automatically prove what happened at the other endpoint.

For serious incidents, capture near both endpoints at the same time:

```bash
# source side
tcpdump -tttt -nn -i any host <destination-ip> and port <port> -w source.pcap

# destination side
tcpdump -tttt -nn -i any host <source-ip> and port <port> -w destination.pcap
```

Then compare packet visibility:

| Source capture | Destination capture | Stronger interpretation |
| --- | --- | --- |
| original packet leaves source, never arrives | loss between capture points |
| original packet arrives, ACK does not return | return-path loss or delayed ACK path |
| destination received original, source retransmits | ACK path issue, capture artifact, or timing ambiguity |
| destination receives late bursts | queueing, buffering, receiver pressure, or path burst behavior |
| neither capture sees expected packet | application did not send or wrong capture filter/path |

This is why a one-sided pcap can be misleading. It can show symptoms but not the full path.

## Understand common analyzer labels

Packet analyzers may label TCP behavior as:

| Label | Practical meaning |
| --- | --- |
| retransmission | sender sent data again |
| fast retransmission | sender retransmitted after duplicate ACK signals, not only after a timeout |
| spurious retransmission | analyzer believes original data may not have been lost |
| duplicate ACK | receiver repeated an ACK for data it has already received up to a point |
| out-of-order | packets arrived in a different order than expected |

RFC 5681 defines duplicate acknowledgments and describes fast retransmit behavior based on duplicate ACKs. That does not mean every duplicate ACK proves packet loss. Reordering, capture placement, ACK loss, and delayed processing can also create confusing traces.

## Causes by evidence

| Evidence | Strong suspect | What to verify |
| --- | --- | --- |
| retransmissions rise with interface drops | local NIC, driver, queue, or virtual network pressure | `ip -s link`, `ethtool -S`, host CPU |
| retransmissions rise with RTT | congestion, queueing, or receiver pressure | RTT trend, queue depth, CPU, softirq |
| only one destination affected | endpoint or path-specific problem | compare same source to other targets |
| only one source affected | source host or source network path | compare other sources to same target |
| large transfers affected more | congestion window, buffering, throughput path | transfer size, cwnd, queueing |
| destination receives data but source retransmits | ACK path or capture placement issue | two-sided capture |
| retransmissions correlate with app locks | receiver not reading quickly | app profiling, socket receive queue |

Every row is a hypothesis. Confirm it before changing network or kernel settings.

## Receiver pressure can look like network loss

If the receiving application stops reading because it is blocked on CPU, locks, GC, disk, database calls, or worker saturation, TCP can back up.

Check:

```bash
ss -tanp | grep '<process>'
ss -tinp | grep '<peer-ip>'
top
pidstat -u 1 5
pidstat -d 1 5
```

Application-level clues:

- request handlers blocked on downstream calls;
- worker pool saturated;
- garbage collection pauses;
- slow disk or logging path;
- response writer blocked;
- receive queue grows while app latency grows.

Do not escalate to the network team before checking whether the receiver can drain the socket.

## Interface and virtual network pressure

On physical hosts:

```bash
ip -s link show <interface>
ethtool -S <interface>
```

Look for counters that increase during the incident, not merely counters that are nonzero.

In virtualized or container environments, also consider:

- veth pair drops;
- bridge or overlay drops;
- virtual NIC queue pressure;
- host-level softirq pressure;
- CNI or service mesh datapath behavior;
- NAT or conntrack pressure.

The exact commands depend on the environment. The principle is stable: prove where packets stop or queue.

## MTR and ping are supporting evidence, not final proof

`mtr` and `ping` can show path latency or ICMP loss:

```bash
mtr -rw <host>
ping -c 100 <host>
```

Use them carefully:

- ICMP may be rate-limited differently from application traffic;
- middle-hop loss is less meaningful if later hops are clean;
- tests after the incident are baseline data, not incident proof;
- application traffic may use a different port, route, proxy, or policy.

Stronger evidence ties retransmission counters, packet captures, interface counters, and application latency to the same time window.

## Fixes by evidence

### If loss is on a host interface

- inspect NIC, driver, cable, switch port, or virtual NIC path;
- check interrupt and softirq pressure;
- compare counters before and after the incident window;
- validate the fix under comparable traffic.

### If congestion or queueing is the cause

- reduce burst pressure;
- shape traffic closer to the source;
- add capacity where the queue forms;
- avoid retry storms that amplify congestion;
- inspect load balancers, firewalls, NAT devices, and overlay paths.

### If receiver pressure is the cause

- fix application read loops;
- reduce downstream blocking;
- scale workers carefully;
- add backpressure instead of unbounded buffering;
- profile CPU, locks, GC, disk, and dependency waits.

### If the path is bad

- compare alternate paths, regions, and source networks;
- collect simultaneous two-sided captures when possible;
- escalate with source, destination, port, timestamps, and evidence;
- include whether packet loss is on forward path, return path, or only inferred.

### If analyzer labels are misleading

- verify sequence and ACK behavior manually for a few packets;
- compare source and destination captures;
- check whether capture offload features affect visibility;
- avoid treating every "spurious retransmission" label as a network outage.

## What not to do

- Do not assume every retransmission is a provider problem.
- Do not rely on one capture point for a serious incident.
- Do not tune TCP globally before proving where loss or delay begins.
- Do not ignore receiver CPU, softirq, socket queues, and application backpressure.
- Do not escalate with only "we saw retransmissions" and no source, destination, port, or time window.
- Do not use ping alone to prove or disprove application TCP loss.

## Incident note template

```text
time window:
source IP:port:
destination IP:port:
application symptom:
latency or timeout impact:
netstat/sar retransmission delta:
ss -ti sample:
interface counters before/after:
CPU/softirq pressure:
source-side capture:
destination-side capture:
forward-path loss evidence:
return-path loss evidence:
receiver queue/app pressure:
recent deploy/config/network change:
confirmed cause:
fix applied:
verification after fix:
```

This separates packet evidence from assumptions.

## Short checklist

- Tie retransmissions to user-visible latency, throughput, or timeout impact.
- Compare counter deltas, not only cumulative counters.
- Identify which side retransmits.
- Inspect interface counters, CPU, softirq, socket queues, and app pressure.
- Use two-sided captures for serious incidents.
- Treat packet analyzer labels as clues until verified against the full path.

## References

- [RFC 9293: Transmission Control Protocol](https://www.rfc-editor.org/rfc/rfc9293)
- [RFC 5681: TCP Congestion Control](https://www.rfc-editor.org/rfc/rfc5681)
- [Linux `tcp(7)` manual](https://www.linuxman7.org/linux/man-pages/man7/tcp.7.html)
- [Linux `ss(8)` manual](https://man7.org/linux/man-pages/man8/ss.8.html)
- [tcpdump documentation](https://www.tcpdump.org/manpages/tcpdump.1.html)
