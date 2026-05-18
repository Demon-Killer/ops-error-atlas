---
title: 'How to fix "502 Bad Gateway" from Nginx'
description: Learn how to separate proxy errors from upstream failures when Nginx returns 502 Bad Gateway.
slug: nginx-502-bad-gateway
publishedAt: 2026-04-29
tags:
  - Nginx
  - HTTP
  - reverse-proxy
related:
  - nginx-upstream-timed-out
  - connection-refused
  - upstream-prematurely-closed-connection
  - nginx-504-gateway-timeout
---

`502 Bad Gateway` from Nginx usually means Nginx could talk to the client but failed to get a valid upstream response. The failure can come from an unavailable upstream, a protocol mismatch, or a response that Nginx could not accept.

## What it means

Nginx is reporting an upstream-side problem. The gateway itself may be healthy while the backend service behind it is not.

## Common causes

- The upstream service is down or restarting.
- Nginx points to the wrong host or port.
- The upstream closed the connection unexpectedly.
- The upstream returned malformed or incomplete data.

## How to diagnose it

Check Nginx and the upstream together. A 502 is rarely useful if you inspect only one side.

1. Compare Nginx error logs with backend logs.
2. Test the upstream directly.
3. Confirm proxy target host, port, and protocol.
4. Look for resets, crashes, or bad responses from the upstream.

## Commands to try

```bash
nginx -T
curl -v http://upstream-service:port/
journalctl -u nginx --since -15m
ss -tanp
```

## How to fix it

Restore the upstream service, correct the proxy target, or fix the backend behavior that causes invalid responses or abrupt disconnects. Only after that should you revisit Nginx settings.

## FAQ

### Is 502 the same as upstream timed out?

No. They are related, but a timeout is one specific failure mode. A 502 can also come from protocol mismatch or bad upstream responses.

### Should I restart Nginx first?

Usually no. Check the upstream service first unless Nginx itself is obviously misconfigured.

## Short checklist

- Test the upstream directly
- Compare Nginx and backend logs
- Confirm proxy target and protocol settings
