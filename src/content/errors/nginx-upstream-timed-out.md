---
title: 'Why "nginx upstream timed out" happens'
description: Understand what Nginx upstream timed out means and how to check whether the issue sits in the proxy, the app, or the network path.
slug: nginx-upstream-timed-out
publishedAt: 2026-05-10
tags:
  - Nginx
  - timeout
  - reverse-proxy
related:
  - curl-28-operation-timed-out
  - connection-reset-by-peer
  - nginx-504-gateway-timeout
  - upstream-prematurely-closed-connection
popular: true
---

`nginx upstream timed out` means Nginx waited for the upstream service but did not receive a response within the configured timeout. The slow part might be the application itself, an overloaded worker pool, or a blocked dependency behind the application.

## What it means

Nginx is acting as the messenger. The timeout means the upstream path did not deliver data in time, not necessarily that Nginx was the original problem.

## Common causes

- Application handlers are slow
- Database or cache dependencies are blocked
- Upstream worker concurrency is exhausted
- Timeout settings are too low for the endpoint

## How to diagnose it

Check application latency before changing proxy settings.

1. Compare Nginx error time with application logs.
2. Measure upstream response time directly.
3. Look for saturation: CPU, worker pools, DB waits.
4. Review `proxy_read_timeout`, `proxy_connect_timeout`, and `proxy_send_timeout`.

## Commands to try

```bash
nginx -T
curl -v http://upstream-service:port/health
top -H -p <pid>
journalctl -u nginx --since -15m
```

## How to fix it

If the endpoint is legitimately slow, optimize the application path first. If the workload is bursty, review queueing and concurrency. Only then revisit Nginx timeout values.

## FAQ

### Is this always an app problem?

No. It can also reflect network issues, DNS instability, or blocked dependencies behind the app.

### Should I raise proxy_read_timeout immediately?

Not first. Measure direct upstream latency before changing proxy timeouts.

## Short checklist

- Compare proxy and app timestamps
- Test the upstream directly
- Look for saturation before raising timeouts
