---
title: 'What does "DNS server unreachable" mean?'
description: Understand DNS server unreachable failures and learn how to separate resolver, network, and upstream DNS problems on Linux.
slug: dns-server-unreachable
publishedAt: 2026-05-14
tags:
  - DNS
  - Linux
  - networking
related:
  - no-route-to-host
  - io-timeout
---

`DNS server unreachable` means the system could not contact the configured resolver within the expected time. That can be caused by a wrong resolver address, broken routing, firewall rules, or an actual outage on the DNS server side.

## What it means

Before your application can reach a host by name, the resolver must contact an upstream DNS server. This error means that contact failed or never completed.

## Common causes

- The configured resolver IP is wrong.
- The network path to the DNS server is broken.
- Firewall rules block UDP or TCP port 53.
- The upstream resolver is down or overloaded.

## How to diagnose it

Check the resolver path from your host outward.

1. Confirm which DNS servers the system is using.
2. Test reachability to the resolver IP directly.
3. Query the resolver manually.
4. Compare DNS behavior for different resolvers if possible.

## Commands to try

```bash
cat /etc/resolv.conf
resolvectl status
ping <dns-server-ip>
dig @<dns-server-ip> example.com
```

## How to fix it

Correct the resolver configuration, restore reachability to the DNS server, allow DNS traffic through the relevant firewalls, or switch to a healthy resolver when the upstream one is unavailable.

## FAQ

### Can this affect only some applications?

Yes. Different applications or containers may use different resolver settings or caches.

### Is DNS server unreachable the same as NXDOMAIN?

No. NXDOMAIN means the resolver answered that the name does not exist. Unreachable means the resolver could not be contacted reliably.

## Short checklist

- Confirm the configured resolver address
- Test network reachability to the resolver
- Query the resolver directly with dig
