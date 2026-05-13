---
title: 'What does "connection reset by peer" mean?'
description: Learn what connection reset by peer usually means, which systems trigger it, and which Linux commands to run first.
slug: connection-reset-by-peer
publishedAt: 2026-05-13
tags:
  - TCP
  - Linux
  - sockets
related:
  - broken-pipe
  - connection-refused
popular: true
---

`connection reset by peer` usually means the remote side closed the TCP connection abruptly before your process finished reading or writing. In production, it often shows up when an upstream service crashes, a proxy enforces an idle timeout, or the client and server disagree about protocol behavior.

## What it means

At the TCP layer, the peer sent a reset instead of closing the connection cleanly. Your application sees the socket disappear immediately, which is why the error often looks sudden and unhelpful.

## Common causes

- The upstream process restarted or crashed.
- A load balancer closed an idle connection.
- The server rejected the request because the protocol stream was malformed.
- Timeout settings between proxy, client, and upstream do not match.

## How to diagnose it

Start by checking whether the reset happens at connect time or during an established session. Then narrow the path.

1. Confirm the application log around the first reset.
2. Check whether proxies or gateways sit between the client and service.
3. Capture packets around the reset event.
4. Compare server and proxy timeout settings.

## Commands to try

```bash
ss -tanp
journalctl -u your-service --since -15m
tcpdump -nn host <peer-ip> and tcp
curl -v https://your-endpoint.example
```

## How to fix it

If the reset is caused by a crash, fix the application first. If it is caused by idle timeouts, align timeout values from client to proxy to upstream. If the reset appears only on specific payloads, inspect protocol framing and header handling.

## FAQ

### Is this always a network problem?

No. Many resets come from application behavior, proxy policies, or overload conditions rather than a broken network.

### Can a firewall cause it?

Yes. Some middleboxes close or reject flows aggressively, especially after idle periods.

## Short checklist

- Check whether the upstream restarted
- Compare timeout values across the request path
- Use packet capture to see who sent the reset
