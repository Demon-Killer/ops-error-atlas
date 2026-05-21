---
title: What causes TCP retransmissions
description: A practical TCP retransmission guide that separates packet loss, congestion, receiver pressure, reordering, bad links, and misleading one-sided packet captures.
slug: tcp-retransmissions
publishedAt: 2026-05-06
updatedAt: 2026-05-20
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

TCP retransmissions happen when a sender decides previously sent data was not acknowledged in time and sends it again. They are a symptom, not a root cause. The cause may be packet loss, congestion, receiver pressure, packet reordering, a bad link, or a capture taken from only one side of the path.

## What it means

TCP expects acknowledgments for sent data. When acknowledgments do not arrive as expected, the sender retransmits. A few retransmissions are normal on real networks. Frequent retransmissions raise latency, reduce throughput, and can trigger application timeouts.

The sender is the side that retransmits, but that does not mean the sender is at fault. The ACK may have been lost on the return path, the receiver may be overloaded, or a capture point may have missed packets that arrived elsewhere.

## Common causes

- Real packet loss on the path.
- Congestion and queue drops.
- Receiver CPU or socket buffer pressure.
- Packet reordering that looks like loss.
- Bad NIC, cable, switch port, or virtual network path.
- Asymmetric routing or middlebox behavior.

## Define whether retransmissions matter

Before opening a network ticket, connect retransmissions to user impact:

```text
time window:
source and destination:
protocol and port:
retransmission increase:
latency or timeout impact:
affected percentage:
```

Low background retransmissions are normal. A useful investigation starts when retransmissions rise during the same window as slow requests, timeouts, or throughput collapse.

## Fast triage order

1. Confirm retransmissions are frequent enough to matter.
2. Identify which side is retransmitting.
3. Check whether retransmissions correlate with load.
4. Inspect host counters and interface errors.
5. Capture from both sides if the incident matters.
6. Separate network loss from receiver-side delay.

## Commands to try

### Check TCP counters

```bash
netstat -s | grep -Ei 'retrans|timeout|segments retransmited'
sar -n TCP,ETCP 1 10
```

Watch whether counters rise during the incident window.

Take before/after samples. Absolute counters are cumulative since boot and can mislead if you do not compare deltas.

### Inspect active TCP flows

```bash
ss -ti
```

This may show retransmission count, RTT, congestion window, and delivery rate for active sockets.

For a specific peer:

```bash
ss -ti dst <peer-ip>
```

Look for rising `retrans`, high RTT, shrinking congestion window, or send queues that do not drain.

### Capture traffic

```bash
tcpdump -nn -i any host <peer-ip> and tcp
```

One-sided captures can mislead you. If possible, capture near both endpoints and compare what was sent, what arrived, and what was acknowledged.

Add timestamps when matching with logs:

```bash
tcpdump -tttt -nn -i any host <peer-ip> and port <port>
```

If source capture shows retransmits but destination capture shows the original packet arrived, investigate ACK loss, capture placement, asymmetric routing, or receiver scheduling.

### Check interface and host counters

```bash
ip -s link
ethtool -S <interface>
top
vmstat 1 5
```

Receiver overload can delay ACKs and look like a network problem.

Also inspect softirq pressure on busy Linux hosts:

```bash
mpstat -P ALL 1 5
cat /proc/softirqs
```

A host that cannot process packets fast enough may create symptoms similar to path loss.

## How to interpret retransmissions

| Signal | Likely direction |
| --- | --- |
| retransmissions rise with interface drops | local link or queue problem |
| retransmissions rise with CPU saturation | receiver or sender host pressure |
| only one route or region affected | path or provider problem |
| only large transfers affected | congestion, buffering, or throughput limit |
| one-sided capture shows retransmits but peer received data | capture point or ACK path issue |
| retransmissions rise with high send queue | receiver or network cannot drain data |
| duplicate ACKs appear before fast retransmit | likely loss or reordering |
| destination sees data but ACKs return late | return path or receiver scheduling issue |

## Two-sided capture logic

Use this simple decision model:

| Source capture | Destination capture | Interpretation |
| --- | --- | --- |
| packet sent, not received | path loss between capture points |
| packet sent and received, ACK missing at source | return-path loss or delayed ACK |
| source retransmits, destination already received original | spurious retransmit, ACK path, or capture artifact |
| destination receives late bursts | queueing, buffering, or receiver pressure |

This is why one packet capture rarely proves the full story.

## Retransmission types matter

In packet analyzers you may see:

- normal retransmission;
- fast retransmission;
- spurious retransmission;
- duplicate ACKs;
- out-of-order packets.

Do not treat all of them the same. Duplicate ACKs and fast retransmissions often point toward packet loss or reordering. Spurious retransmissions may point toward delayed ACKs, capture artifacts, or timing ambiguity.

Out-of-order packets are not automatically bad. Some network paths reorder under load. TCP can tolerate limited reordering, but heavy reordering can trigger retransmissions and reduce throughput.

## What not to assume

- Do not assume every retransmission means a bad network provider.
- Do not ignore receiver CPU and socket buffer pressure.
- Do not rely on one capture point for a serious incident.
- Do not tune TCP globally before identifying where loss or delay begins.
- Do not escalate provider tickets with only "tcp retransmissions" and no source/destination/time window.
- Do not ignore application backpressure that prevents the receiver from reading quickly.

## How to fix it

### If loss is on a host interface

- fix NIC, driver, cable, switch port, or virtual NIC pressure;
- inspect interrupt and CPU saturation;
- reduce queue drops.

Validate the fix by watching retransmission deltas fall during comparable traffic, not just by checking that the interface is up.

### If congestion is the cause

- reduce burst pressure;
- add capacity;
- shape traffic closer to the source;
- inspect queueing devices and middleboxes.

### If receiver pressure is the cause

- scale workers;
- inspect socket buffers and application read loops;
- reduce downstream blocking.

If the application stops reading because it is waiting on a database or lock, network metrics may degrade even though the network path is healthy. Fix the receiver's ability to drain data.

### If the path is bad

- compare alternate paths or regions;
- collect time-windowed evidence;
- escalate with source, destination, timestamps, and packet evidence.

Provider escalation should include both endpoint IPs, protocol/port, UTC timestamps, `mtr` or path evidence during the bad window, and whether two-sided captures prove packet loss between specific points.

## Short checklist

- Confirm retransmissions rise during the incident.
- Identify which side retransmits.
- Check interface, CPU, and socket pressure.
- Capture from both sides when possible.
- Fix the loss or delay point before tuning TCP.
- Tie retransmissions to application latency or timeout impact.
