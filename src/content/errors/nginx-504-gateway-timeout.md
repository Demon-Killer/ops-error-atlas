---
title: 'How to debug 504 Gateway Timeout between Nginx and upstream services'
description: A practical Nginx 504 troubleshooting guide that separates slow upstream code, dependency latency, connection problems, and unsafe timeout changes.
slug: nginx-504-gateway-timeout
publishedAt: 2026-05-14
updatedAt: 2026-05-19
tags:
  - Nginx
  - timeout
  - reverse-proxy
related:
  - nginx-upstream-timed-out
  - nginx-502-bad-gateway
  - nginx-499-client-closed-request
  - upstream-prematurely-closed-connection
popular: true
---

`504 Gateway Timeout` from Nginx means Nginx waited too long for the upstream side of the request path. It is a timing symptom, not a root cause. The real bottleneck may be application code, a database or cache behind the app, queueing under load, a bad network path, or timeout values that do not match production behavior.

## What it means

A common request path looks like this:

```text
client -> load balancer -> Nginx -> upstream service -> database/cache/API
```

Nginx returns `504` when it cannot get the expected upstream response in time. Nginx is often the first component that reports the failure, but it is not always the component that caused it.

The first useful question is:

```text
Did Nginx fail while connecting to upstream, sending the request, or waiting for the response?
```

That distinction decides whether you should inspect network reachability, request body upload, upstream processing time, or downstream dependencies.

## Common causes

- The upstream handler is slow or blocked.
- A database, Redis, queue, or downstream API is slow.
- The upstream worker pool is saturated, so requests wait before executing.
- Nginx can connect, but upstream does not send response headers in time.
- Timeout settings such as `proxy_read_timeout` are lower than real response latency.
- One upstream instance has packet loss, CPU pressure, or a bad deploy.

## Fast triage order

Use this order before changing any timeout:

1. Find the exact Nginx access log and error log lines for the failing request.
2. Compare `request_time` and `upstream_response_time` if your access log records them.
3. Check whether the upstream app saw the same request and whether it completed.
4. Test the upstream directly from the Nginx host.
5. Check dependency latency at the same timestamp.
6. Inspect network symptoms only if app and dependency timing do not explain the delay.
7. Change timeout values only after you know which wait is legitimate.

## What to look for in logs

If your Nginx access log includes upstream timing fields, it becomes much easier to reason about 504s.

Useful fields include:

- `$request_time`: total time Nginx spent on the request.
- `$upstream_connect_time`: time to establish upstream connection.
- `$upstream_header_time`: time until upstream response headers arrive.
- `$upstream_response_time`: total time spent receiving upstream response.
- `$upstream_status`: status returned by the upstream, if any.

A useful log format might include these fields:

```nginx
log_format upstream_timing '$remote_addr "$request" $status '
    'request_time=$request_time '
    'upstream_status=$upstream_status '
    'upstream_connect_time=$upstream_connect_time '
    'upstream_header_time=$upstream_header_time '
    'upstream_response_time=$upstream_response_time '
    'upstream_addr=$upstream_addr';
```

If `upstream_connect_time` is high, inspect reachability and network path. If `upstream_header_time` is high, inspect upstream application and dependencies. If the upstream app never logs the request, inspect routing, DNS, load balancer, or connection setup.

## How to separate likely causes

| Signal | Likely direction |
| --- | --- |
| Direct upstream `curl` is also slow | App or dependency is slow |
| Only one upstream instance fails | Bad node, bad deploy, or host-level pressure |
| `upstream_connect_time` is high | Network, DNS, routing, or upstream accept backlog |
| App logs show long DB time | Database/cache/downstream dependency |
| App finishes just after Nginx timeout | Timeout may be too low, but still inspect why it is slow |
| Client gives up first and Nginx logs `499` | Client timeout may be shorter than proxy/app path |

## Commands to try

Run these from the Nginx host when possible.

### Check active Nginx configuration

```bash
nginx -T | grep -E 'proxy_(connect|send|read)_timeout|upstream|keepalive'
```

Look specifically at:

- `proxy_connect_timeout`
- `proxy_send_timeout`
- `proxy_read_timeout`
- upstream host/port definitions
- keepalive settings

### Inspect recent Nginx errors

```bash
journalctl -u nginx --since -30m
tail -200 /var/log/nginx/error.log
```

Search for phrases such as:

- `upstream timed out`
- `while connecting to upstream`
- `while reading response header from upstream`
- `while sending request to upstream`

Those phrases tell you which phase timed out.

### Measure the upstream directly

```bash
curl -v http://upstream-service:port/health
curl -s -o /dev/null \
  -w 'connect=%{time_connect} starttransfer=%{time_starttransfer} total=%{time_total}\n' \
  http://upstream-service:port/path
```

If direct upstream requests are already slow, Nginx is probably only reporting a backend-side delay.

### Check saturation

```bash
ss -tan state established '( sport = :80 or sport = :443 )'
ss -tanp | grep '<upstream-port>'
top -H -p <upstream-pid>
```

For a Linux service, also check application worker count, queue depth, and restart events.

### Check dependencies

```bash
redis-cli --latency
mysql -e 'show processlist;'
curl -v http://dependency-host:port/health
```

Many 504s are dependency problems exposed at the proxy boundary.

### Check transport symptoms

```bash
tcpdump -nn host <upstream-ip> and port <upstream-port>
netstat -s | grep -i retrans
mtr -rw <upstream-ip>
```

Use packet captures when logs do not explain the timing. They are useful for proving retransmissions, resets, or one bad upstream node.

## When changing timeout settings is correct

Changing timeouts is reasonable when:

- the endpoint is intentionally long-running;
- the upstream finishes successfully just beyond the current timeout;
- downstream capacity is healthy;
- client timeout, load balancer timeout, and Nginx timeout are aligned.

Changing timeouts is unsafe when:

- the upstream is blocked on a dependency;
- worker pools are saturated;
- only one node fails;
- logs show crashes, restarts, or resets.

## How to fix it

### If the upstream app is slow

- profile the handler;
- remove unnecessary downstream calls;
- fix lock contention or thread starvation;
- increase worker capacity only if concurrency is the proven bottleneck.

### If a dependency is slow

- fix DB/cache/API latency first;
- reduce fan-out;
- add caching where correctness allows it;
- set dependency timeouts lower than the proxy timeout so failures are visible inside the app.

### If the timeout is genuinely too low

Raise the specific timeout that matches the failing phase. Avoid increasing every timeout at once.

### If one upstream node is bad

- remove it from rotation;
- compare CPU, memory, network counters, and app version;
- check deploy timing and restart history.

## Related errors and how they differ

### `502 Bad Gateway`

Usually means Nginx received a broken or invalid upstream response. A 502 can happen without a timeout.

### `499 Client Closed Request`

Usually means the client gave up before Nginx finished. It often appears next to slow upstream paths.

### `upstream prematurely closed connection`

Means the upstream closed too early. That is different from waiting too long for a response.

## Short checklist

- Locate the exact Nginx error line and request timestamp.
- Compare `request_time` with upstream timing fields.
- Test the upstream directly from the Nginx host.
- Check app and dependency latency before changing Nginx timeouts.
- Treat timeout changes as a final alignment step, not the first fix.
