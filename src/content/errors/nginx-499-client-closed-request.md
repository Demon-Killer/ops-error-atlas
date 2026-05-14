---
title: 'Why Nginx returns 499 Client Closed Request'
description: Learn what Nginx 499 means and how to tell whether clients, proxies, or slow upstreams caused the disconnect.
slug: nginx-499-client-closed-request
publishedAt: 2026-05-14
tags:
  - Nginx
  - HTTP
  - reverse-proxy
related:
  - nginx-upstream-timed-out
  - broken-pipe
---

Nginx `499 Client Closed Request` means the client closed the connection before Nginx finished sending the response. The code is logged by Nginx, not returned as a standard HTTP status to the client, so it is mainly a troubleshooting signal for the server operator.

## What it means

The request reached Nginx, but the client or a client-side intermediary gave up before the response completed. This often happens when the upstream is too slow or when a proxy on the client side enforces a shorter timeout.

## Common causes

- Slow upstream responses
- Client-side or proxy-side timeouts
- Users canceling requests manually
- Large responses over unstable connections

## How to diagnose it

Treat 499 as a timing problem first.

1. Compare Nginx access logs with upstream response time.
2. Check whether specific endpoints show a high 499 rate.
3. Compare 499 spikes with latency spikes or upstream errors.
4. Inspect whether a load balancer in front of Nginx has a shorter timeout than expected.

## Commands to try

```bash
nginx -T
grep ' 499 ' /var/log/nginx/access.log | tail -50
curl -w 'total:%{time_total}\n' -o /dev/null -s https://<host>/<path>
journalctl -u nginx --since -15m
```

## How to fix it

Reduce upstream latency, align timeout settings across clients and proxies, and avoid streaming large responses through paths that are likely to be canceled or reset early.

## FAQ

### Is 499 an application error?

Not directly. It is a signal that the connection ended from the client side before Nginx could finish.

### Can upstream slowness cause 499?

Yes. Slow upstreams are one of the most common reasons users or proxies give up.

## Short checklist

- Correlate 499 with upstream latency
- Check client and proxy timeout values
- Look for endpoint-specific spikes
