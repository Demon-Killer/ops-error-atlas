---
title: How to debug intermittent packet loss
description: A practical guide to intermittent packet loss that explains how to prove timing, direction, path, host counters, queue drops, and application impact.
slug: intermittent-packet-loss
publishedAt: 2026-05-03
updatedAt: 2026-05-20
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

Intermittent packet loss is harder than a complete outage because the path looks healthy part of the time. You need to prove when loss happens, which direction is affected, which path is involved, and whether the loss correlates with traffic bursts, interface errors, queue drops, or overloaded receivers.

## What it means

Packets are being dropped only sometimes. The trigger may be:

- burst traffic;
- one upstream provider;
- one interface;
- one host;
- one region;
- one time window;
- one traffic class.

The mistake is taking one clean ping result and declaring the path healthy.

## Common causes

- Queue drops during traffic bursts.
- Interface errors, bad cables, or unstable links.
- Firewall, NAT, VPN, or appliance limits.
- Congestion on one provider or route.
- Receiver CPU pressure delaying packet processing.
- Asymmetric routing where only one direction is bad.

## Fast triage order

1. Record the exact time window when users report failures.
2. Compare affected and unaffected destinations.
3. Run repeated path measurements, not one snapshot.
4. Check interface counters and TCP retransmissions.
5. Capture traffic on both ends if possible.
6. Correlate loss with traffic volume, CPU, deploys, and provider events.

## Commands to try

### Repeated path measurement

```bash
mtr -rw <host>
ping -c 200 <host>
```

Use these as signals, not final proof. ICMP behavior may differ from application traffic.

### Interface counters

```bash
ip -s link
ethtool -S <interface>
```

Look for increments in:

- `rx_dropped`
- `tx_dropped`
- `rx_errors`
- `tx_errors`
- CRC errors
- queue drops

### TCP retransmission counters

```bash
netstat -s | grep -Ei 'retrans|timeout'
sar -n TCP,ETCP 1 10
```

Rising retransmission counters during the incident are stronger evidence than occasional loss in a single test.

### Packet capture

```bash
tcpdump -nn -i any host <peer-ip>
```

Capture on both sides if you can. One side alone may only show symptoms, not the drop point.

## How to interpret results

| Signal | Likely direction |
| --- | --- |
| loss increases only under high throughput | queue drops or congestion |
| one interface shows errors | local link or NIC issue |
| one region affected | provider or routing path |
| application traffic fails but ping is clean | traffic-class, port, proxy, or receiver pressure |
| retransmissions rise with CPU saturation | host cannot process traffic fast enough |

## One-way loss matters

Packet loss can be asymmetric. The outbound path may be healthy while the return path drops packets. That is why testing from both sides, or comparing client-side and server-side captures, is valuable.

## What not to do

- Do not rely on one `ping`.
- Do not assume no ICMP loss means no application loss.
- Do not ignore host counters.
- Do not escalate to a provider without timestamps, paths, and evidence.

## How to fix it

### If the host interface is dropping packets

- inspect NIC, driver, cable, and switch port;
- check interrupt and CPU saturation;
- review queue settings only after confirming drops.

### If loss appears on one path

- compare routes from multiple locations;
- collect `mtr` during the bad window;
- escalate with timestamps and destination/source pairs.

### If loss appears under bursts

- reduce burst size;
- shape traffic earlier;
- inspect queue lengths and buffer pressure;
- scale receivers or upstream workers.

## Short checklist

- Capture the bad time window.
- Compare good and bad peers.
- Check interface counters before blaming the provider.
- Correlate loss with traffic and CPU.
- Use two-sided captures when the direction is unclear.
