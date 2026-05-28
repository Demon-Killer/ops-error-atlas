---
title: 'Why "nginx upstream timed out" happens'
description: A practical guide to Nginx upstream timed out errors that separates connect, send, and read timeouts from slow apps, dependency latency, and overloaded upstream workers.
slug: nginx-upstream-timed-out
publishedAt: 2026-05-10
updatedAt: 2026-05-28
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

`nginx upstream timed out` is the Nginx error-log symptom behind many `504 Gateway Timeout` responses. The phrase means one upstream operation did not make progress before its configured timeout expired.

The critical detail is the suffix after `while`:

```text
while connecting to upstream
while sending request to upstream
while reading response header from upstream
while reading upstream
```

Those are different failures. If you treat them all as "the backend is slow" or "increase `proxy_read_timeout`", you will make bad changes.

The right question is:

```text
Which Nginx upstream operation timed out, and which directive owns that timer?
```

This article focuses on that mapping. For the client-facing HTTP status, see the related `504 Gateway Timeout` guide.

## The timeout map

For a proxied HTTP request, Nginx may need to:

```text
client -> Nginx -> upstream service -> dependency chain
```

The upstream part has several distinct waits:

| Nginx error-log phase | Nginx directive to inspect | What is waiting |
| --- | --- | --- |
| `while connecting to upstream` | `proxy_connect_timeout` | Nginx is establishing a TCP connection to the upstream |
| `while sending request to upstream` | `proxy_send_timeout` | Nginx is writing request headers/body to the upstream |
| `while reading response header from upstream` | `proxy_read_timeout` | Nginx is waiting for upstream response headers |
| `while reading upstream` | `proxy_read_timeout` | Nginx is waiting for more response body data |

NGINX documents `proxy_send_timeout` and `proxy_read_timeout` as timeouts between successive write or read operations, not total request duration caps. That distinction matters for streaming and large responses: a long response may be allowed if data keeps flowing, while a shorter response can time out if the upstream stalls between reads.

## Start from one complete error line

Preserve the full line:

```text
2026/05/28 10:15:20 [error] 1234#1234: *42 upstream timed out (110: Connection timed out) while reading response header from upstream, client: 203.0.113.10, server: example.com, request: "GET /api/report HTTP/1.1", upstream: "http://10.0.3.17:8080/api/report", host: "example.com"
```

Extract:

- the phase after `while`;
- the upstream address;
- the route and method;
- whether this happened before headers or during body transfer;
- the timestamp for app and dependency log correlation.

Do not average multiple incidents together at first. Pick one representative request and prove its failure path.

## Add upstream timing to access logs

If access logs do not include upstream timing fields, add them before the next incident. They let you separate connect latency from app handler latency and body-transfer stalls.

```nginx
log_format upstream_timing
  '$remote_addr request_id=$request_id '
  '"$request" status=$status bytes=$body_bytes_sent '
  'rt=$request_time '
  'uaddr="$upstream_addr" ustatus="$upstream_status" '
  'uct="$upstream_connect_time" uht="$upstream_header_time" urt="$upstream_response_time" '
  'host="$host" uri="$request_uri"';

access_log /var/log/nginx/access.log upstream_timing;
```

How to read the fields:

- `$request_time` is total request processing time inside Nginx.
- `$upstream_addr` shows the selected upstream peer. With retries, there may be multiple comma-separated peers.
- `$upstream_status` shows upstream status if Nginx received one.
- `$upstream_connect_time` measures upstream connection setup.
- `$upstream_header_time` measures time until response headers arrive.
- `$upstream_response_time` measures the upstream response exchange, including body.

NGINX documents upstream timing values as seconds with millisecond resolution. Multiple upstream attempts can produce comma-separated values. Interpret timing together with the error-log phase, not in isolation.

## Inspect the active timeout config

Run this on the Nginx host or inside the Nginx container:

```bash
nginx -T | grep -E 'proxy_(connect|send|read)_timeout|proxy_next_upstream|proxy_pass|upstream|keepalive|resolver'
```

You are looking for the effective value in the `http`, `server`, or `location` block that matches the failing route.

Common trap: a global timeout exists, but the route has a more specific `location` override. `nginx -T` shows the rendered configuration; use it instead of reading only one file.

## Case 1: Timeout while connecting to upstream

Error phrase:

```text
upstream timed out (110: Connection timed out) while connecting to upstream
```

This is controlled by `proxy_connect_timeout`. Nginx has not completed the TCP connection to the upstream.

Strong signals:

- `$upstream_connect_time` is high or missing.
- The same upstream IP appears repeatedly.
- Direct `curl` from the Nginx environment is slow to connect.
- Other upstream peers are healthy.

First checks:

```bash
curl -v --connect-timeout 3 http://10.0.3.17:8080/health
ss -ltnp
ss -s
netstat -s | grep -Ei 'retrans|timeout|reset|listen|overflow'
```

Likely causes:

- upstream process is not accepting connections quickly;
- host firewall or network policy drops packets;
- routing or service discovery points to a bad address;
- upstream accept backlog is saturated;
- one node has packet loss, CPU throttling, or network pressure.

Fix path:

1. Confirm the upstream address from the Nginx log.
2. Test the exact address and port from Nginx's network namespace.
3. Compare with a known-good peer.
4. Remove a bad peer from rotation if necessary.
5. Fix listener, routing, backlog, firewall, service discovery, or node health.

Raising `proxy_connect_timeout` may reduce visible errors if slow connection setup is expected. It is not a fix for a blackholed route, a dead peer, or overloaded accept path.

## Case 2: Timeout while sending request to upstream

Error phrase:

```text
upstream timed out (110: Connection timed out) while sending request to upstream
```

This is controlled by `proxy_send_timeout`. Nginx is connected, but a write operation to the upstream did not complete in time.

Strong signals:

- route accepts uploads or large request bodies;
- failure correlates with large JSON payloads, file uploads, or slow client upload patterns;
- upstream app logs do not show handler start, or show delayed body reads;
- Nginx can connect quickly but stalls while sending the request.

First checks:

```bash
nginx -T | grep -E 'client_max_body_size|client_body_timeout|proxy_request_buffering|proxy_send_timeout'
curl -v -X POST --data-binary @large-payload.bin http://upstream-service:8080/upload
```

Likely causes:

- upstream app is not reading request body promptly;
- upload route is sharing workers with normal API traffic;
- request buffering behavior does not match the endpoint design;
- upstream process is saturated and not consuming socket data;
- request body is too large for the synchronous path.

Fix path:

- separate uploads from latency-sensitive API routes;
- enforce explicit request size limits;
- make the app read or reject bodies promptly;
- consider direct-to-object-storage upload flows for large files;
- align `client_body_timeout`, `proxy_send_timeout`, and app body-read deadlines;
- review `proxy_request_buffering` only after understanding memory, disk, and streaming tradeoffs.

Do not diagnose this as a database query problem until you prove the app actually received and started processing the request.

## Case 3: Timeout while reading response header from upstream

Error phrase:

```text
upstream timed out (110: Connection timed out) while reading response header from upstream
```

This is controlled by `proxy_read_timeout`. Nginx sent the request and is waiting for the upstream to start a response.

This is the most common application-side pattern.

Strong signals:

- `$upstream_connect_time` is low;
- `$upstream_header_time` approaches the configured `proxy_read_timeout`;
- app logs show the request started but no response was written before Nginx timed out;
- dependency logs show slow database, cache, queue, or external API calls.

First checks:

```bash
journalctl -u your-service --since -30m
grep -R "slow\\|timeout\\|deadlock\\|pool\\|exhausted\\|trace_id" /var/log/your-service/
curl -s -o /dev/null \
  -w 'connect=%{time_connect} starttransfer=%{time_starttransfer} total=%{time_total}\n' \
  http://upstream-service:8080/problem-path
```

Check runtime-specific bottlenecks:

| Runtime | High-value checks |
| --- | --- |
| JVM | GC pause, blocked threads, executor saturation, DB pool wait |
| Node.js | event loop delay, CPU-bound handler, missing outbound HTTP timeout |
| Go | context deadline, goroutine blocking, DB pool wait, pprof profiles |
| Python | gunicorn/uwsgi worker saturation, sync dependency calls, slowlog |
| PHP-FPM | `pm.max_children`, slowlog, script timeout, backend pool saturation |

Likely causes:

- slow database query or lock wait;
- cache outage causing slow fallback;
- external API call without a shorter timeout;
- worker/thread pool saturation;
- request queueing before handler execution;
- deadlock or CPU-bound handler.

Fix path:

1. Break the handler into timed spans: queue wait, auth, DB/cache, downstream API, render/serialization.
2. Set dependency client timeouts shorter than the app handler deadline.
3. Return a controlled application error before Nginx reaches `proxy_read_timeout`.
4. Optimize the slow dependency or reduce fan-out.
5. Raise `proxy_read_timeout` only for routes that are intentionally long-running and have enough capacity.

If Nginx times out first, the application may keep working after the client is gone. That wastes resources and hides the component that should have failed first.

## Case 4: Timeout while reading response body

Error phrase may look like:

```text
upstream timed out (110: Connection timed out) while reading upstream
```

This is also controlled by `proxy_read_timeout`, but the failure happens after response headers. It is a body-transfer stall, not necessarily a slow start.

Strong signals:

- response headers arrive, then transfer stalls;
- small responses work while large exports, downloads, or streams fail;
- `$upstream_header_time` is low, while `$upstream_response_time` approaches the timeout;
- app logs show an exception or dependency stall after partial output.

Likely causes:

- streaming generator stalls between chunks;
- export/report endpoint pauses while paging through a database;
- upstream app blocks after committing headers;
- a middle proxy or app write timeout interrupts the stream;
- downstream client cancellation is not propagated cleanly.

Fix path:

- move long exports to background jobs and downloadable artifacts;
- send deliberate heartbeats for streaming protocols where appropriate;
- propagate client cancellation to expensive upstream work;
- avoid committing success headers before the operation has passed its main failure point;
- align client, load balancer, Nginx, and app timeouts for body duration.

Because `proxy_read_timeout` is between read operations, a stream that sends periodic chunks can live longer than the numeric timeout value. A stream that stalls longer than the timeout can fail even if total duration is not very large.

## Case 5: Retry policy changes what you see

`proxy_next_upstream` can make Nginx try another upstream after some errors or timeouts. This is useful for resilience, but it complicates diagnosis.

Inspect it:

```bash
nginx -T | grep -A5 -B5 'proxy_next_upstream'
```

Watch for:

- multiple comma-separated `$upstream_addr` values;
- multiple upstream timing values;
- a final 504 after several peers were tried;
- retry storms under partial outage;
- unsafe retries for non-idempotent requests.

Use retries to reduce impact, not to hide a sick peer forever. If only one upstream node is slow, fix or remove that node. If all nodes are slow because a database is saturated, retries can multiply load and make the incident worse.

## Build a sane timeout budget

Timeouts should be ordered so the inner component fails with useful evidence before the outer component gives up.

Example for a normal API route:

```text
database client timeout:      2s
app handler deadline:         3s
Nginx proxy_read_timeout:     5s
load balancer timeout:        10s
client timeout:               15s
```

This is an example, not a universal prescription. The property that matters is ordering:

- dependency calls should not outlive the app handler deadline;
- the app should return an explicit error before Nginx times out;
- Nginx should have a budget compatible with outer load balancer and client timeouts;
- long-running routes should have separate contracts and location-level settings.

Bad budgets create confusing mixtures of `499 Client Closed Request`, `504 Gateway Timeout`, duplicate retries, and upstream work that keeps running after users disconnect.

## Direct upstream measurement

Test from the Nginx host, container, or pod:

```bash
curl -v --max-time 10 http://upstream-service:8080/health
curl -s -o /dev/null \
  -w 'dns=%{time_namelookup} connect=%{time_connect} starttransfer=%{time_starttransfer} total=%{time_total}\n' \
  http://upstream-service:8080/problem-path
```

Mapping:

- `time_connect` helps validate connect-timeout branches.
- `time_starttransfer` approximates time to first byte/headers.
- `time_total` includes body transfer.

This does not replace Nginx logs, but it proves whether the upstream path is slow from Nginx's position. A laptop test is not equivalent if Nginx runs in a different network namespace.

## What not to do

- Do not raise `proxy_read_timeout` for a `while connecting to upstream` error.
- Do not raise all proxy timeouts together without mapping the failing phase.
- Do not test only from your laptop.
- Do not ignore `$upstream_addr`; one bad peer can look like a global timeout problem.
- Do not retry non-idempotent requests casually.
- Do not let dependency clients outlive the app and proxy timeout budget.

## Decision tree

```text
Nginx logs upstream timed out
|
+-- while connecting to upstream?
|   |
|   +-- inspect proxy_connect_timeout, address, routing, listener, backlog, node health
|
+-- while sending request to upstream?
|   |
|   +-- inspect proxy_send_timeout, request body size, upload flow, app body reads
|
+-- while reading response header?
|   |
|   +-- inspect proxy_read_timeout, app handler, worker pool, dependency latency
|
+-- while reading upstream/body?
|   |
|   +-- inspect streaming/export path, body generation, periodic progress
|
+-- multiple upstream attempts?
|   |
|   +-- inspect proxy_next_upstream, sick peers, retry amplification
|
+-- 499 appears nearby?
    |
    +-- compare client, load balancer, Nginx, app, dependency timeout budget
```

## Minimal incident note template

```text
Symptom:
- Client-visible status:
- Route:
- First seen:
- Upstream address:

Nginx evidence:
- exact error line:
- phase after "while":
- matching directive:
- configured timeout value:
- upstream_connect_time:
- upstream_header_time:
- upstream_response_time:
- upstream_status:

Application evidence:
- request received? yes/no
- handler start time:
- handler finish time:
- dependency timings:
- worker/pool saturation:

Hypothesis:
- timed-out operation:
- why this evidence supports it:

Fix:
- code/config/capacity change:
- validation command:
```

The goal is not to memorize every Nginx timeout directive. The goal is to map the log phrase to the exact stalled operation, then fix the component responsible for that wait.

## References

- [NGINX `ngx_http_proxy_module`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [NGINX `proxy_connect_timeout` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_connect_timeout)
- [NGINX `proxy_send_timeout` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_send_timeout)
- [NGINX `proxy_read_timeout` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout)
- [NGINX `proxy_request_buffering` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_request_buffering)
- [NGINX `proxy_next_upstream` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream)
- [NGINX upstream embedded variables](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#variables)
- [NGINX logging guide and upstream timing variables](https://docs.nginx.com/nginx/admin-guide/monitoring/logging/)
