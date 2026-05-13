---
title: How to debug intermittent packet loss
description: A practical guide to intermittent packet loss that appears only under load, on one path, or during narrow time windows.
slug: intermittent-packet-loss
publishedAt: 2026-05-03
tags:
  - networking
  - packet-loss
  - Linux
related:
  - tcp-retransmissions
  - high-network-latency
---

Intermittent packet loss is harder than permanent failure because everything looks healthy part of the time. You need timing, path, and traffic context before you can say whether the loss comes from a host, an interface, a queue, or the wider network.

## What it means

Packets are being dropped only sometimes. That often means the trigger is conditional: burst traffic, one route, one interface, one peer, or one time window.

## Common causes

- Queue drops during burst load
- Interface errors or unstable links
- Wireless or WAN instability
- A firewall, appliance, or provider issue affecting one path

## How to diagnose it

Look for correlation. “Sometimes” is the key clue.

1. Check whether loss increases during high traffic.
2. Compare affected and unaffected peers.
3. Inspect interface counters for drops and errors.
4. Use repeated path measurements instead of one snapshot.

## Commands to try

```bash
mtr -rw <host>
ping -c 100 <host>
ethtool -S <interface>
ip -s link
```

## How to fix it

Fix the failing condition. That may mean reducing burst pressure, replacing a bad cable or interface, rerouting traffic, or escalating with evidence to a provider if the loss is outside your host.

## FAQ

### Why does ping sometimes look clean?

Because the loss may only appear during a certain load profile or on application traffic that behaves differently from ICMP.

### Can packet loss happen only in one direction?

Yes. Asymmetric path problems are common enough that you should not assume both directions behave the same way.

## Short checklist

- Look for the trigger condition
- Compare healthy and unhealthy paths
- Collect interface and path evidence over time
