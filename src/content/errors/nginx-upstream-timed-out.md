---
title: 'Why "nginx upstream timed out" happens'
description: A practical guide to Nginx upstream timed out errors that separates connect, send, and read timeouts from slow apps, dependency latency, and overloaded upstream workers.
slug: nginx-upstream-timed-out
publishedAt: 2026-05-10
updatedAt: 2026-05-19
tags:
  - Nginx
  - timeout
  - reverse-proxy
related:
  - nginx-504-gateway-timeout
  - nginx-502-bad-gateway
  - upstream-prematurely-closed-connection
  - connection-reset-by-peer
popular: true
---

`nginx upstream timed out` means Nginx waited for an upstream operation longer than the configured timeout. The exact phrase in the error log matters because it usually tells you whether Nginx timed out while connecting, sending the request, or reading the response.

## What it means

Nginx sits between the client and the upstream service:

```text
client -> Nginx -> upstream service -> database/cache/API
```

When Nginx logs `upstream timed out`, it is reporting that the upstream side of this path did not progress fast enough. The root cause may be:

- network reachability between Nginx and upstream;
- upstream accept backlog or worker saturation;
- slow application code;
- blocked database, cache, or downstream API;
- timeout values that do not match expected production latency.

Do not start by increasing every timeout. Start by identifying which phase timed out.

## Read the full Nginx error line

The error message often includes a phase:

```text
upstream timed out (110: Connection timed out) while connecting to upstream
upstream timed out (110: Connection timed out) while sending request to upstream
upstream timed out (110: Connection timed out) while reading response header from upstream
```

These are different problems.

| Error phase | First direction to check |
| --- | --- |
| `while connecting to upstream` | DNS, routing, listener, firewall, accept backlog |
| `while sending request to upstream` | large request body, slow upstream reads, request buffering |
| `while reading response header from upstream` | app handler latency, DB/cache/API waits, worker saturation |
| timeout during response body | streaming response, buffering, slow downstream path |

## Common causes

- The upstream application handler is slow.
- The upstream is waiting on a database, cache, queue, or external API.
- Worker threads or processes are exhausted.
- The upstream host is reachable but not accepting fast enough.
- Nginx and upstream keepalive behavior does not match.
- `proxy_read_timeout`, `proxy_connect_timeout`, or `proxy_send_timeout` is too low for the specific workload.

## Fast triage flow

1. Copy the full Nginx error line, including the `while ...` phrase.
2. Match the timestamp with access logs and upstream app logs.
3. Check whether the upstream app received and completed the request.
4. Test the upstream directly from the Nginx host.
5. Compare timing fields such as `$upstream_connect_time`, `$upstream_header_time`, and `$upstream_response_time`.
6. Inspect dependency latency before changing Nginx timeouts.

## Useful access log fields

If possible, include upstream timing fields in your access logs:

```nginx
log_format upstream_timing '$remote_addr "$request" $status '
    'request_time=$request_time '
    'upstream_status=$upstream_status '
    'upstream_addr=$upstream_addr '
    'upstream_connect_time=$upstream_connect_time '
    'upstream_header_time=$upstream_header_time '
    'upstream_response_time=$upstream_response_time';
```

This helps separate connection setup delay from app processing delay.

## Commands to try

### Inspect Nginx config

```bash
nginx -T | grep -E 'proxy_(connect|send|read)_timeout|upstream|keepalive'
```

Check whether the timeout mentioned in the log phase matches the configured value.

### Read recent Nginx logs

```bash
journalctl -u nginx --since -30m
tail -200 /var/log/nginx/error.log
tail -200 /var/log/nginx/access.log
```

### Test upstream from the Nginx host

```bash
curl -v http://upstream-service:port/health
curl -s -o /dev/null \
  -w 'connect=%{time_connect} starttransfer=%{time_starttransfer} total=%{time_total}\n' \
  http://upstream-service:port/path
```

If direct upstream requests are slow, the problem is probably behind Nginx.

### Check upstream saturation

```bash
ss -tanp | grep '<upstream-port>'
top -H -p <upstream-pid>
```

Also check service-specific metrics such as worker queue depth, thread pool usage, and request latency percentiles.

### Check dependency latency

```bash
redis-cli --latency
mysql -e 'show processlist;'
curl -v http://dependency-host:port/health
```

If DB or cache latency spikes at the same timestamp, Nginx is only reporting the symptom.

## How to fix it

### If timeout happens while connecting

- confirm upstream host and port;
- check service listener with `ss -ltnp`;
- check DNS and service discovery;
- inspect firewall, routing, and upstream accept backlog.

### If timeout happens while reading response header

- profile the application handler;
- check dependency latency;
- inspect worker saturation and queueing;
- add app-side timeout logs so the slow dependency is visible.

### If timeout happens only under load

- compare healthy and unhealthy upstream nodes;
- inspect CPU, memory, file descriptors, and thread pools;
- review load balancer distribution and deploy timing.

### If timeout values are truly too low

Adjust the specific timeout that matches the failing phase. Do not raise every timeout together without proving why.

## Common mistakes

- Treating every timeout as an Nginx problem.
- Raising `proxy_read_timeout` before checking app logs.
- Ignoring the `while connecting` vs `while reading response header` phrase.
- Testing upstream from a laptop instead of from the Nginx host.
- Looking only at average latency instead of high percentiles and queueing.

## Related errors and how they differ

### `504 Gateway Timeout`

The client-facing HTTP status that often results from upstream timeout.

### `502 Bad Gateway`

Usually means a broken or invalid upstream response, not necessarily a timeout.

### `upstream prematurely closed connection`

Means upstream closed too early. That is different from Nginx waiting too long.

## Short checklist

- Keep the full error line and identify the timeout phase.
- Compare Nginx timing fields with upstream app logs.
- Test upstream from the Nginx host, not only from your laptop.
- Check dependency latency before changing proxy timeouts.
- Tune only the timeout that matches the proven failure phase.
