---
title: 'What does "no route to host" mean?'
description: Learn how no route to host differs from timeout and refusal errors, and how to inspect routing and reachability on Linux.
slug: no-route-to-host
publishedAt: 2026-04-30
tags:
  - Linux
  - routing
  - networking
related:
  - connection-refused
  - high-network-latency
---

`no route to host` means the operating system does not know how to reach the target IP through the current routing table or network path. This often points to a missing route, a broken gateway path, or a network policy issue rather than an application bug.

## What it means

The host cannot determine a usable path to the destination. The failure happens before the application protocol even has a chance to matter.

## Common causes

- Missing or incorrect routes
- Wrong gateway configuration
- A down interface or unreachable subnet
- Security policy or firewall blocks that break reachability

## How to diagnose it

Treat this as a routing problem first.

1. Inspect the local routing table.
2. Confirm the gateway is reachable.
3. Check whether the target subnet is expected on this host.
4. Compare working and failing destinations.

## Commands to try

```bash
ip route
ip addr
ping <gateway-ip>
traceroute <host>
```

## How to fix it

Add the missing route, correct the gateway, bring the expected interface back up, or fix the network policy that blocks the path. If the route is correct locally, investigate the upstream network path next.

## FAQ

### Is this the same as connection timeout?

No. A route failure is more fundamental. The system cannot find a usable path, while a timeout usually means packets were sent but no timely response came back.

### Can a firewall trigger no route to host?

Yes. Depending on policy and environment, blocked reachability can surface in ways that resemble routing failures.

## Short checklist

- Inspect local routes first
- Confirm gateway reachability
- Compare working and failing destinations
