---
title: 'How to debug 504 Gateway Timeout between Nginx and upstream services'
description: A practical guide to 504 Gateway Timeout that separates proxy timeouts from real upstream slowness, packet delay, and dependency bottlenecks.
slug: nginx-504-gateway-timeout
publishedAt: 2026-05-14
tags:
  - Nginx
  - timeout
  - reverse-proxy
related:
  - nginx-upstream-timed-out
  - nginx-502-bad-gateway
  - nginx-499-client-closed-request
popular: true
---

`504 Gateway Timeout` from Nginx means the proxy waited too long for the upstream side of the request path. The important detail is that a 504 is a timing symptom, not a root cause. The real bottleneck might sit in the upstream application, the database behind it, a slow network path, or timeout settings that do not match real response behavior.

## What it means

In a typical setup, the request path looks like this:

```text
client -> load balancer -> Nginx -> upstream service -> database/cache/other dependencies
```

Nginx returns 504 when the upstream side of that chain does not deliver the expected response quickly enough. That does **not** automatically mean Nginx is broken. It often means Nginx is the first component that noticed a slower dependency behind it.

## Common causes

- The upstream application takes too long to process the request.
- The upstream service is blocked on a database, cache, or another downstream API.
- The network path between Nginx and the upstream is unstable or slow.
- Timeout settings such as `proxy_read_timeout` are lower than real production latency.
- The upstream worker pool is exhausted and requests queue before they start executing.

## 5-minute triage flow

If you need a fast first pass, use this order:

1. Find the exact Nginx error log line and timestamp.
2. Check whether the upstream app log shows the same request finishing slowly or not at all.
3. Test the upstream directly from the Nginx host.
4. Check whether DB, Redis, or dependency latency spiked at the same time.
5. Only after that decide whether a timeout setting is actually too low.

That order matters. If you start by raising timeouts, you often hide the real bottleneck instead of fixing it.

## How to separate proxy, upstream, and network causes

### Case 1: The upstream is simply slow

This is the most common case. Direct requests to the upstream are also slow, and application logs show long handler times or long waits on dependencies.

Typical signals:

- Nginx logs 504 at time `T`
- Upstream logs show the request started at `T - x`
- Upstream logs show the request finishes much later, or never finishes
- DB or cache latency spikes at the same time

### Case 2: The network path between Nginx and upstream is unstable

This is less common than application slowness, but it matters in distributed or container-heavy setups.

Typical signals:

- Direct `curl` to upstream sometimes hangs
- Packet captures show retransmissions or resets
- One upstream instance fails more often than others
- Nginx and upstream logs do not line up cleanly

### Case 3: Timeout values are too aggressive

This should be the **last** conclusion, not the first.

Typical signals:

- The request usually succeeds if given slightly more time
- The endpoint is expensive by design
- Application logs show stable, valid completions just beyond the current timeout

## Commands to try

Run these from the Nginx host first.

### Check the active Nginx configuration

```bash
nginx -T
```

Focus on:

- `proxy_read_timeout`
- `proxy_connect_timeout`
- `proxy_send_timeout`
- upstream blocks and keepalive settings

### Look at recent Nginx errors

```bash
journalctl -u nginx --since -15m
tail -100 /var/log/nginx/error.log
```

### Test the upstream directly

```bash
curl -v http://upstream-service:port/health
curl -w 'connect:%{time_connect} starttransfer:%{time_starttransfer} total:%{time_total}\n' -o /dev/null -s http://upstream-service:port/path
```

If direct upstream requests are already slow, the problem is probably behind Nginx.

### Check host and worker saturation

```bash
top -H -p <upstream-pid>
ss -tanp
```

### Check downstream dependencies

```bash
mysql -e 'show processlist;'
redis-cli --latency
curl -v http://dependency-host:port/health
```

### If you suspect transport issues

```bash
tcpdump -nn host <upstream-ip>
netstat -s | grep -i retrans
mtr -rw <upstream-ip>
```

## What not to do first

These are common low-value reactions:

- Increase every timeout blindly
- Restart Nginx before checking upstream logs
- Assume a 504 is always a network problem
- Assume a 504 is always an Nginx misconfiguration

Each of those actions can delay the real fix.

## How to fix it

### If the upstream app is slow

- profile the endpoint
- reduce DB round-trips
- fix lock contention
- increase worker capacity if concurrency is the limit

### If a downstream dependency is slow

- fix DB or cache latency first
- add caching where it is safe
- reduce fan-out to slow services

### If the timeout is genuinely too low

Raise only the timeout that matches the real bottleneck. Do not raise every proxy timeout together unless you know why.

### If the network path is bad

- identify the failing hop or instance
- compare healthy and unhealthy upstream nodes
- look for retransmissions, drops, or queue pressure

## Related errors and how they differ

### `502 Bad Gateway`

Usually means Nginx got a bad or broken upstream response, not necessarily a timeout.

### `499 Client Closed Request`

Usually means the client gave up before Nginx finished. It often appears together with slow upstreams.

### `upstream timed out`

This is often the Nginx error log message that sits behind the 504 status code.

## FAQ

### Should I increase `proxy_read_timeout` immediately?

No. First prove that the application is healthy and simply needs more time. Otherwise you risk hiding a slow dependency or broken code path.

### Can 504 be caused by the database instead of the app server?

Yes. Many 504s are really DB, cache, or downstream API latency problems that only surface at the proxy layer.

### Why does direct curl to the service work but Nginx still returns 504?

Because the Nginx path may add concurrency, keepalive reuse, load balancer behavior, or timeout settings that your one-off curl test does not reproduce.

## Short checklist

- Start with Nginx log timestamp
- Compare direct upstream latency with proxied latency
- Check DB/cache/API dependencies before changing timeouts
- Use packet captures only when app and dependency timings do not explain the delay
