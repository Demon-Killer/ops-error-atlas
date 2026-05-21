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

The second mistake is assuming packet loss is always in the provider network. Loss can happen before a packet leaves the host, inside a virtual switch, at a NAT gateway, in a firewall appliance, on the return path, or inside an overloaded receiver that cannot drain packets fast enough.

## Common causes

- Queue drops during traffic bursts.
- Interface errors, bad cables, or unstable links.
- Firewall, NAT, VPN, or appliance limits.
- Congestion on one provider or route.
- Receiver CPU pressure delaying packet processing.
- Asymmetric routing where only one direction is bad.

## Define the loss precisely

Before collecting commands, define the incident in operational terms:

```text
source:
destination:
protocol and port:
time window:
failure rate:
affected region or subnet:
application symptom:
```

Without source and destination pairs, "packet loss" is too vague to fix. Loss from one office to one region does not prove loss from your production service to its database. Loss in ICMP does not always prove loss in TCP application traffic.

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

When you need time-series evidence:

```bash
for i in $(seq 1 60); do
  date -Is
  ping -c 5 <host> | tail -2
  sleep 10
done
```

This is crude but useful when the issue appears in short bursts.

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

Read counters twice during the incident. A counter that is high but not increasing may be historical. A counter that climbs during the bad window is evidence.

### TCP retransmission counters

```bash
netstat -s | grep -Ei 'retrans|timeout'
sar -n TCP,ETCP 1 10
```

Rising retransmission counters during the incident are stronger evidence than occasional loss in a single test.

For a specific socket:

```bash
ss -ti dst <peer-ip>
```

Look for retransmission state, congestion window changes, and round-trip time movement.

### Packet capture

```bash
tcpdump -nn -i any host <peer-ip>
```

Capture on both sides if you can. One side alone may only show symptoms, not the drop point.

For an application-specific check:

```bash
tcpdump -tttt -nn -i any host <peer-ip> and port <port>
```

This avoids spending time on unrelated ICMP behavior when the real symptom is TCP traffic to a specific service.

## How to interpret results

| Signal | Likely direction |
| --- | --- |
| loss increases only under high throughput | queue drops or congestion |
| one interface shows errors | local link or NIC issue |
| one region affected | provider or routing path |
| application traffic fails but ping is clean | traffic-class, port, proxy, or receiver pressure |
| retransmissions rise with CPU saturation | host cannot process traffic fast enough |
| only return traffic is missing | asymmetric path, firewall, NAT, or reverse-route issue |
| `mtr` shows loss at one hop but later hops are clean | ICMP rate limiting on that hop, not necessarily forwarding loss |
| drops rise on one host only | local NIC, driver, queue, or namespace pressure |
| loss appears only during backup or batch jobs | burst congestion or queue exhaustion |

## One-way loss matters

Packet loss can be asymmetric. The outbound path may be healthy while the return path drops packets. That is why testing from both sides, or comparing client-side and server-side captures, is valuable.

Two-sided capture is the strongest simple proof:

- packet leaves source but never arrives at destination: path loss;
- packet arrives at destination but response never reaches source: return-path loss;
- packet never leaves source: host, firewall, or local queue problem;
- response is delayed by the destination: receiver pressure or application scheduling.

## Reading mtr without overreacting

`mtr` is useful, but intermediate routers may rate-limit ICMP replies. Loss shown at an intermediate hop is only meaningful when the same or worse loss continues to later hops, especially the destination.

More reliable pattern:

- destination loss increases during the same window users report failures;
- latency and loss rise together at the destination;
- multiple sources show the same bad final path;
- TCP retransmissions rise at the same time.

Less reliable pattern:

- one middle hop shows loss, but all later hops are clean;
- only ICMP fails while application traffic and TCP metrics look normal;
- tests are run after the incident window has passed.

## What not to do

- Do not rely on one `ping`.
- Do not assume no ICMP loss means no application loss.
- Do not ignore host counters.
- Do not escalate to a provider without timestamps, paths, and evidence.
- Do not treat every `mtr` middle-hop loss line as packet forwarding loss.

## How to fix it

### If the host interface is dropping packets

- inspect NIC, driver, cable, and switch port;
- check interrupt and CPU saturation;
- review queue settings only after confirming drops.

Also check whether drops happen inside a container or virtual network path, not only on the physical interface. A clean host NIC does not rule out veth, bridge, overlay, or pod-level drops.

### If loss appears on one path

- compare routes from multiple locations;
- collect `mtr` during the bad window;
- escalate with timestamps and destination/source pairs.

Provider escalations are more effective when they include: source IP, destination IP, UTC timestamps, protocol/port, sample packet loss rate, traceroute or `mtr` output during the incident, and whether the return path was tested.

### If loss appears under bursts

- reduce burst size;
- shape traffic earlier;
- inspect queue lengths and buffer pressure;
- scale receivers or upstream workers.

Burst loss is often fixed by smoothing traffic before it reaches the constrained queue, not by increasing application retry count. More retries during a loss burst can amplify congestion.

## Application impact checklist

Loss matters most when it changes user-visible behavior. Connect packet-level evidence to application metrics:

- TCP retransmissions;
- request latency p95/p99;
- timeout rate;
- retry rate;
- upstream saturation;
- queue depth;
- regional error distribution.

This prevents chasing harmless ICMP rate limiting while ignoring real application failure.

## Short checklist

- Capture the bad time window.
- Compare good and bad peers.
- Check interface counters before blaming the provider.
- Correlate loss with traffic and CPU.
- Use two-sided captures when the direction is unclear.
- Escalate with source, destination, timestamp, protocol, and proof of application impact.
