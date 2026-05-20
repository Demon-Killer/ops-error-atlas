---
title: How to investigate high network latency on Linux
description: A practical Linux latency guide that separates RTT, TCP connect time, TLS setup, server processing, queueing, retransmissions, and slow dependencies.
slug: high-network-latency
publishedAt: 2026-05-05
updatedAt: 2026-05-20
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

High network latency is not one problem. It can come from distance, routing, queueing, packet loss, retransmissions, TLS setup, overloaded receivers, or a slow application that looks like network delay from the client side. The useful work is separating transport latency from application latency.

## What it means

Latency is the time a request spends moving through the path. For a backend request, that path often includes:

```text
client -> DNS -> TCP connect -> TLS -> proxy -> upstream app -> database/cache/API
```

If you only measure total request time, you cannot tell whether the delay is network, TLS, proxy, application, or dependency latency.

## Common causes

- Long physical or geographic distance.
- Congested links and queue buildup.
- Packet loss causing TCP retransmissions.
- Slow DNS resolution.
- TLS handshake delay.
- Server CPU, thread pool, or accept queue pressure.
- Slow database, cache, or downstream API hidden behind the service.

## Fast triage order

1. Measure round-trip time with a simple tool.
2. Break HTTP latency into DNS, connect, TLS, first byte, and total time.
3. Compare latency from multiple client locations.
4. Check for packet loss and retransmissions.
5. Inspect server-side saturation and dependency latency.
6. Only then tune timeout values or kernel settings.

## Commands to try

### Measure path behavior

```bash
ping -c 20 <host>
mtr -rw <host>
```

Use `mtr` to see whether delay or loss appears near the client, near the destination, or somewhere in the middle.

### Break down HTTP timing

```bash
curl -s -o /dev/null \
  -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
  https://<host>
```

High `connect` time points toward TCP path or listener pressure. High `first_byte` with normal connect time points toward app, proxy, or dependency delay.

### Inspect TCP state

```bash
ss -ti
netstat -s | grep -Ei 'retrans|timeout|listen|reset'
```

`ss -ti` can show retransmission and congestion window details for active TCP flows.

### Check host-level saturation

```bash
top
vmstat 1 5
sar -n TCP,ETCP 1 5
```

Network latency often gets blamed for CPU, scheduler, or worker-pool pressure on the receiving host.

## How to separate likely causes

| Signal | Likely direction |
| --- | --- |
| High `ping`, high `connect` | network path, routing, or listener pressure |
| Low `connect`, high `first_byte` | application, proxy, or dependency latency |
| `mtr` loss starts at one hop and continues | possible path loss |
| retransmissions rise during incident | packet loss, queueing, or receiver pressure |
| only one upstream node is slow | host-level or instance-level issue |
| only one region is slow | routing or geographic path issue |

## What not to assume

- Do not assume high total request time is network latency.
- Do not rely on one `ping` result.
- Do not ignore application logs if TCP connect is fast.
- Do not tune kernel parameters before proving packet loss, queueing, or host pressure.

## How to fix it

### If the network path is slow

- compare routes from different clients;
- collect `mtr` evidence over time;
- check provider, VPN, firewall, and cross-region routing.

### If packet loss is present

- inspect interface errors and drops;
- check queue pressure;
- compare healthy and unhealthy paths;
- investigate bad links or overloaded devices.

### If first byte is slow

- inspect upstream app latency;
- check database/cache/API timing;
- compare proxy logs with app logs.

### If only one instance is slow

- remove it from rotation temporarily;
- compare CPU, memory, network counters, and app version;
- check deploy and restart history.

## Short checklist

- Break latency into DNS, connect, TLS, first byte, and total.
- Compare multiple clients and upstream instances.
- Check retransmissions and interface drops before blaming the network path.
- Treat high first-byte time as an application or dependency clue.
- Keep timing evidence before changing timeouts.
