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

## Common causes

- Real packet loss on the path.
- Congestion and queue drops.
- Receiver CPU or socket buffer pressure.
- Packet reordering that looks like loss.
- Bad NIC, cable, switch port, or virtual network path.
- Asymmetric routing or middlebox behavior.

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

### Inspect active TCP flows

```bash
ss -ti
```

This may show retransmission count, RTT, congestion window, and delivery rate for active sockets.

### Capture traffic

```bash
tcpdump -nn -i any host <peer-ip> and tcp
```

One-sided captures can mislead you. If possible, capture near both endpoints and compare what was sent, what arrived, and what was acknowledged.

### Check interface and host counters

```bash
ip -s link
ethtool -S <interface>
top
vmstat 1 5
```

Receiver overload can delay ACKs and look like a network problem.

## How to interpret retransmissions

| Signal | Likely direction |
| --- | --- |
| retransmissions rise with interface drops | local link or queue problem |
| retransmissions rise with CPU saturation | receiver or sender host pressure |
| only one route or region affected | path or provider problem |
| only large transfers affected | congestion, buffering, or throughput limit |
| one-sided capture shows retransmits but peer received data | capture point or ACK path issue |

## Retransmission types matter

In packet analyzers you may see:

- normal retransmission;
- fast retransmission;
- spurious retransmission;
- duplicate ACKs;
- out-of-order packets.

Do not treat all of them the same. Duplicate ACKs and fast retransmissions often point toward packet loss or reordering. Spurious retransmissions may point toward delayed ACKs, capture artifacts, or timing ambiguity.

## What not to assume

- Do not assume every retransmission means a bad network provider.
- Do not ignore receiver CPU and socket buffer pressure.
- Do not rely on one capture point for a serious incident.
- Do not tune TCP globally before identifying where loss or delay begins.

## How to fix it

### If loss is on a host interface

- fix NIC, driver, cable, switch port, or virtual NIC pressure;
- inspect interrupt and CPU saturation;
- reduce queue drops.

### If congestion is the cause

- reduce burst pressure;
- add capacity;
- shape traffic closer to the source;
- inspect queueing devices and middleboxes.

### If receiver pressure is the cause

- scale workers;
- inspect socket buffers and application read loops;
- reduce downstream blocking.

### If the path is bad

- compare alternate paths or regions;
- collect time-windowed evidence;
- escalate with source, destination, timestamps, and packet evidence.

## Short checklist

- Confirm retransmissions rise during the incident.
- Identify which side retransmits.
- Check interface, CPU, and socket pressure.
- Capture from both sides when possible.
- Fix the loss or delay point before tuning TCP.
