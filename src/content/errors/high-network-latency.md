---
title: How to investigate high network latency on Linux
description: A practical way to break down high network latency into path delay, queueing, retransmissions, and server-side slowness.
slug: high-network-latency
publishedAt: 2026-05-05
tags:
  - Linux
  - networking
  - latency
related:
  - tcp-retransmissions
  - io-timeout
---

High network latency is not one problem. It can come from physical distance, routing changes, queue buildup, packet loss, slow TLS setup, or simply a slow upstream application that looks like network delay from the client side.

## What it means

The time between request and response is higher than expected. The key is to separate transport delay from application delay before changing network settings or tuning timeouts.

## Common causes

- Long physical or geographic paths
- Congested links or queue buildup
- Packet loss and retransmissions
- Slow upstream services misread as network delay

## How to diagnose it

Measure the path in phases rather than treating all latency as one number.

1. Measure round-trip time.
2. Check for hop-by-hop instability.
3. Compare TCP connect time with total response time.
4. Look for retransmissions, queueing, or server saturation.

## Commands to try

```bash
ping <host>
mtr -rw <host>
curl -w 'connect:%{time_connect} tls:%{time_appconnect} total:%{time_total}\n' -o /dev/null -s https://<host>
ss -ti
```

## How to fix it

Fix the slow phase. If the network path is long or unstable, work there. If the transport is fine but total response time is high, move to the application or database tier instead of blaming the network.

## FAQ

### Is ping enough to diagnose latency?

No. Ping only measures one kind of round-trip behavior and says nothing about application queuing or TLS overhead.

### Can server overload look like network latency?

Yes. Slow upstream handlers often appear to clients as “network slowness.”

## Short checklist

- Break latency into phases
- Compare connect time and total time
- Check path stability before changing timeouts
