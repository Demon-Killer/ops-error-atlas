---
title: 'How to debug 504 Gateway Timeout between Nginx and upstream services'
description: A practical Nginx 504 troubleshooting guide that separates slow upstream code, dependency latency, connection problems, and unsafe timeout changes.
slug: nginx-504-gateway-timeout
publishedAt: 2026-05-14
updatedAt: 2026-05-27
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

`504 Gateway Timeout` from Nginx means Nginx was acting as a gateway or reverse proxy and did not receive a timely upstream response. It is a timeout symptom, not a root cause.

RFC 9110 defines `504 Gateway Timeout` as a gateway/proxy not receiving a timely response from an upstream server needed to complete the request. In a real Nginx stack, that upstream server might be your application, a service mesh sidecar, another load balancer, or a backend dependency chain exposed through the app.

The operational mistake is to treat 504 as "increase `proxy_read_timeout`". Sometimes that is correct. Often it only hides the failure while making client waits, worker occupancy, and retry storms worse.

The better question is:

```text
Which wait exceeded its budget: connect to upstream, send request to upstream, wait for response headers, receive response body, or wait on a downstream dependency behind the app?
```

Answer that before changing any timeout.

## The request path

A common production path looks like this:

```text
client -> CDN / load balancer -> Nginx -> upstream app -> database / cache / queue / external API
```

Nginx is only one timer in that path. The client has a timeout. The CDN（内容分发网络）or load balancer may have a timeout. Nginx has upstream timeouts. The application has handler and dependency timeouts. The database, cache, queue, and external API also have latency behavior.

A correct 504 investigation builds a time budget across those layers instead of changing one Nginx directive in isolation.

## Start with the exact Nginx error phrase

Nginx usually tells you which upstream phase timed out. Preserve the full error log line, not only the client-facing status code.

| Nginx error phrase | Timed-out phase | First branch |
| --- | --- | --- |
| `upstream timed out ... while connecting to upstream` | TCP connection establishment | Upstream reachability, SYN backlog, routing, firewall, overloaded accept path |
| `upstream timed out ... while sending request to upstream` | Nginx was sending request body/headers upstream | Large upload, slow upstream read, request buffering, app not reading body |
| `upstream timed out ... while reading response header from upstream` | Nginx sent the request and waited too long for response headers | Slow handler, saturated worker pool, database/cache/API latency, app deadlock |
| `upstream timed out ... while reading upstream` | Nginx received headers but response body stalled | Streaming endpoint, slow body generation, upstream write stall, dependency pagination/export |
| Access log has no upstream status | Nginx may not have received a complete upstream response | Connect/read timeout, upstream never produced usable headers |

Most application 504s happen while reading response headers. That means Nginx reached the upstream and is waiting for the app to start responding. The root cause is often inside the app or its dependencies, not inside Nginx.

## Log the timing fields that separate root causes

If your access log does not include upstream timing, you are debugging 504s with one eye closed. Add a log format that captures total request time, selected upstream, upstream status, and upstream phase timings.

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

Interpretation:

- `$request_time` is total time Nginx spent processing the request.
- `$upstream_addr` is the selected upstream address. With retries, it can contain multiple addresses.
- `$upstream_status` is the status returned by upstream, if one was received.
- `$upstream_connect_time` is time spent establishing the upstream connection.
- `$upstream_header_time` is time until Nginx received response headers from upstream.
- `$upstream_response_time` is total upstream response time, including body transfer.

NGINX documents upstream timing variables as seconds with millisecond resolution. When multiple upstream attempts happen, values can be comma-separated. When a phase did not complete, you may see `-` or incomplete upstream status. Therefore, read the timing fields with the error log line at the same timestamp.

## Build a timeout budget

A stable proxy stack has ordered timeouts. The closer component should usually fail before the outer component gives up, so the failure is logged at the layer that can explain it.

Example timeout budget for a normal API endpoint:

```text
app dependency timeout:       2s
app handler deadline:         3s
Nginx proxy_read_timeout:     5s
load balancer idle timeout:   10s
client timeout:               15s
```

This is an example, not a universal recommendation. The important property is ordering:

- Dependencies fail before the app handler blocks forever.
- The app returns a controlled error before Nginx times out.
- Nginx times out before the outer load balancer or client silently disconnects.
- Long-running endpoints have their own explicit contract instead of borrowing global API timeouts.

If the database client waits 30 seconds, the app handler waits 30 seconds, Nginx waits 60 seconds, and the browser waits 20 seconds, you will see confusing mixtures of `499 Client Closed Request`, `504 Gateway Timeout`, retries, and half-finished work.

## Fast triage flow

Use this order during an incident:

1. Copy the exact Nginx error log line and the matching access log line.
2. Identify the timeout phase: connect, send, header, or body.
3. Check whether the upstream app logged the same request and how long it ran.
4. Test the same upstream route from the same network namespace as Nginx.
5. Compare dependency latency at the same timestamp.
6. Check saturation: worker pool, thread pool, event loop, DB connection pool, queue depth, CPU throttling.
7. Change timeout values only if the measured work is expected and the whole timeout budget is aligned.

The phrase "same network namespace" matters. If Nginx runs in a container or Kubernetes pod, a direct test from your laptop can bypass the exact DNS, routing, network policy, and service discovery path that Nginx uses.

## Commands that answer the first branch

### Inspect Nginx timeout and upstream config

```bash
nginx -T | grep -E 'proxy_(connect|send|read)_timeout|send_timeout|upstream|keepalive|proxy_next_upstream|resolver|proxy_pass'
```

Focus on the directives that map to the timed-out phase:

- `proxy_connect_timeout` limits establishing a connection to the proxied server.
- `proxy_send_timeout` limits time between write operations while sending the request to upstream.
- `proxy_read_timeout` limits time between read operations while receiving the response from upstream.
- `proxy_next_upstream` controls whether Nginx retries another upstream after some failures.
- `keepalive` affects upstream connection reuse and capacity behavior.

Do not raise all three proxy timeouts together. If the error says "while reading response header from upstream", raising `proxy_connect_timeout` is not addressing the failing phase.

### Inspect recent Nginx logs

```bash
journalctl -u nginx --since -30m
tail -200 /var/log/nginx/error.log
tail -200 /var/log/nginx/access.log
```

Search for:

```text
upstream timed out
while connecting to upstream
while sending request to upstream
while reading response header from upstream
while reading upstream
```

Keep one representative log line with upstream address, request path, and timestamp.

### Test upstream from Nginx's environment

```bash
curl -v --max-time 10 http://upstream-service:8080/health
curl -s -o /dev/null \
  -w 'dns=%{time_namelookup} connect=%{time_connect} starttransfer=%{time_starttransfer} total=%{time_total}\n' \
  http://upstream-service:8080/problem-path
```

Map curl timings carefully:

- `time_connect` helps approximate connection setup latency.
- `time_starttransfer` is time to first response byte, roughly comparable to waiting for response headers.
- `time_total` includes the response body.

This is not a perfect replacement for Nginx timing, but it is a useful independent measurement from the same network position.

### Check application logs and runtime saturation

```bash
journalctl -u your-service --since -30m
grep -R "timeout\\|slow\\|deadlock\\|pool\\|exhausted\\|OOM\\|killed" /var/log/your-service/
top -H -p <upstream-pid>
ss -tanp | grep ':8080'
```

For runtime-specific checks, look at the bottleneck that can make handlers wait before they even start useful work:

| Runtime pattern | What to inspect |
| --- | --- |
| JVM service | GC pauses, thread pool saturation, blocked threads, connection pool wait |
| Node.js service | Event loop delay, CPU-bound handler, outbound HTTP client timeout, unhandled promise stalls |
| Go service | Goroutine blocking, context deadlines, DB pool waits, pprof CPU/block profiles |
| Python service | Worker count, GIL-bound CPU work, sync dependency calls, gunicorn/uwsgi timeout |
| PHP-FPM | `pm.max_children`, slowlog, backend pool saturation, script execution timeout |

Do not assume "CPU is low" means the app is healthy. A service can be idle while every request is waiting on a database lock or a depleted connection pool.

### Check dependency latency

Many 504s are dependency latency surfacing at the proxy boundary.

```bash
redis-cli --latency
mysql -e 'show processlist;'
psql -c "select now(), state, wait_event_type, wait_event from pg_stat_activity limit 20;"
curl -v --max-time 5 http://dependency-host:port/health
```

Use the commands that match your stack. The goal is not to run every command. The goal is to prove whether the application spent most of the request waiting below itself.

### Check network symptoms only after logs do not explain timing

```bash
ss -s
netstat -s | grep -Ei 'retrans|timeout|reset'
tcpdump -nn -i any host <upstream-ip> and port <upstream-port>
mtr -rw <upstream-ip>
```

Packet capture is valuable when application and dependency logs do not explain the delay, or when only one upstream node has high connect/header time. It is overkill when the app log already says the database query took longer than Nginx's read timeout.

## Case 1: Timeout while connecting to upstream

Strong signals:

- Error log says `while connecting to upstream`.
- `$upstream_connect_time` is high or missing for failing attempts.
- Direct tests from Nginx are slow to connect.
- The same upstream node appears repeatedly.

Likely causes:

- Upstream host is overloaded and not accepting quickly.
- SYN backlog or accept queue pressure.
- Firewall, routing, or service discovery issue.
- One bad node or one bad availability zone.
- DNS resolution points Nginx to an unhealthy address.

Fix path:

1. Confirm the target address from `$upstream_addr`.
2. Test the same address and port from Nginx's environment.
3. Compare with a known-good upstream peer.
4. Remove the bad peer from rotation if the issue is node-specific.
5. Fix host-level pressure, listener backlog, firewall, or service discovery.

Increasing `proxy_connect_timeout` may reduce visible 504s if the network occasionally connects slowly, but it also makes users wait longer and ties up proxy resources. Treat it as alignment after you understand why connect time is high.

## Case 2: Timeout while sending request to upstream

Strong signals:

- Error log says `while sending request to upstream`.
- Failures correlate with large uploads or large request bodies.
- Upstream app logs do not show handler start, or show delayed body reads.
- Nginx can connect quickly but cannot finish sending request data.

Likely causes:

- Upstream reads request bodies slowly or stops reading.
- Request buffering behavior does not match endpoint design.
- Large uploads are routed through an endpoint designed for small JSON requests.
- The upstream process is saturated and not consuming socket data.

Fix path:

- Separate large upload endpoints from normal API endpoints.
- Ensure upstream reads or rejects request bodies promptly.
- Use object storage direct upload patterns when appropriate.
- Align `client_body_timeout`, `proxy_send_timeout`, and application body-read deadlines.
- Prefer explicit upload limits over letting large requests occupy proxy and app resources until timeout.

## Case 3: Timeout while reading response header from upstream

This is the classic application-side 504.

Strong signals:

- Error log says `while reading response header from upstream`.
- `$upstream_connect_time` is low, but `$upstream_header_time` approaches the timeout.
- App logs show the request started but did not finish before Nginx timed out.
- Dependency logs show slow queries, blocked locks, queue waits, or external API slowness.

Likely causes:

- Slow database query or lock wait.
- Cache outage causing fallback to slow path.
- External API call without a shorter client timeout.
- Worker/thread pool saturation.
- Request queueing before the handler starts.
- Deadlock, event-loop blocking, or CPU-bound code.

Fix path:

1. Add or inspect request-level tracing inside the app.
2. Break handler time into queue wait, auth, DB/cache, downstream API, render/serialization.
3. Set dependency client timeouts below the app handler deadline.
4. Return a controlled error from the app before Nginx reaches its read timeout.
5. Optimize the slow dependency or reduce fan-out.
6. Only raise `proxy_read_timeout` for endpoints that are intentionally long-running and documented as such.

A healthy design gives the app a chance to explain the failure. If Nginx times out first, the app often keeps working after the client is gone, wasting resources and hiding the real cause.

## Case 4: Timeout while reading response body

If headers arrive but the body stalls, the route is not simply "slow to start". It may be slow to finish.

Strong signals:

- Error log says `while reading upstream` or timing shows body transfer dominates.
- Headers are sent quickly, but large exports, reports, downloads, or streaming responses fail.
- Smaller responses succeed.
- Failures correlate with slow clients, buffering settings, or large dependency reads.

Likely causes:

- Streaming code blocks mid-response.
- Export/report generation pauses while paging through a database.
- Upstream write timeout fires because Nginx or a middle proxy stops reading.
- Response buffering settings do not match the endpoint.

Fix path:

- Separate interactive API endpoints from bulk export endpoints.
- Paginate or asynchronously generate large reports.
- Use background jobs plus downloadable artifacts for long-running exports.
- Make streaming heartbeat and cancellation behavior explicit.
- Align Nginx, app, and client timeouts for the expected body duration.

## Case 5: One upstream peer is slow

If only one upstream address appears in failed logs, the problem is probably not the global timeout value.

Compare the bad peer with healthy peers:

- app version and deploy timestamp;
- CPU throttling and memory pressure;
- restart count and OOM kills;
- file descriptor usage;
- DB connection pool wait;
- network retransmissions or packet loss;
- local disk saturation if the route reads files or logs heavily.

Use `proxy_next_upstream` carefully. It can route around some failures, but it can also hide a sick node until traffic load changes. Retries also multiply downstream pressure when the real problem is saturation.

## Case 6: Client timeout creates confusing 499/504 pairs

If clients or outer load balancers give up before Nginx finishes, you may see `499 Client Closed Request` near the same incident window. That does not mean the 504 is fake. It means different callers hit different timeout limits.

Example:

```text
mobile client timeout:        10s
load balancer timeout:        30s
Nginx proxy_read_timeout:     60s
app dependency timeout:       90s
```

This is a bad budget. The client may disconnect first, Nginx logs 499, and the app may still run long after the user has gone away. Another caller with a longer timeout may see 504. Fix the budget so the app or inner dependency fails first and returns a controlled response.

## When increasing timeouts is correct

Increasing a timeout is justified when all of these are true:

- The endpoint is intentionally long-running.
- The user-facing contract allows the longer wait.
- The app and dependencies have their own deadlines.
- Worker pools and connection pools can handle the longer occupancy.
- Outer client/load balancer timeouts are longer than the Nginx timeout.
- You can prove the request usually completes successfully just beyond the current limit.

Examples:

- A report export that legitimately takes 40 seconds and is rarely called.
- A streaming endpoint with documented idle heartbeat behavior.
- A migration period where a downstream dependency is slower but still stable.

Even then, prefer endpoint-specific location blocks over raising global proxy timeouts for the whole site.

## When increasing timeouts is unsafe

It is unsafe when:

- The app is blocked on an overloaded database.
- Worker pools are saturated.
- Only one upstream node is slow.
- The request is a normal interactive API call.
- Clients already time out before Nginx.
- Retries are multiplying the same slow downstream work.

In those cases, a larger timeout turns a visible failure into a capacity drain.

## 504 vs 502 vs 499

| Status | Meaning at the proxy boundary | First investigation |
| --- | --- | --- |
| `504 Gateway Timeout` | Nginx waited too long for upstream progress | Time budget, app/dependency latency, timed-out phase |
| `502 Bad Gateway` | Nginx received no usable upstream response | Connection failure, invalid headers, TLS, early close |
| `499 Client Closed Request` | Client closed before Nginx completed | Client/load balancer timeout, slow upstream path, cancellation |

These can appear together in the same incident. That usually means the stack has inconsistent timeout budgets around one slow path.

## Decision tree

```text
Nginx returned 504
|
+-- error says while connecting?
|   |
|   +-- check upstream address, routing, listener, backlog, node health
|
+-- error says while sending request?
|   |
|   +-- check large body upload, request buffering, app body reads
|
+-- error says while reading response header?
|   |
|   +-- check app handler, worker pool, DB/cache/API latency
|
+-- error says while reading upstream/body?
|   |
|   +-- check streaming/export/body generation path
|
+-- logs show one upstream peer only?
|   |
|   +-- compare that node against healthy peers
|
+-- 499 appears nearby?
    |
    +-- compare client, load balancer, Nginx, app, dependency timeouts
```

## Minimal incident note template

```text
Symptom:
- Client-visible status:
- Route:
- First seen:
- Affected upstream address:

Nginx evidence:
- exact error phrase:
- request_time:
- upstream_connect_time:
- upstream_header_time:
- upstream_response_time:
- upstream_status:
- proxy timeout that fired:

Application evidence:
- request received? yes/no
- handler duration:
- queue wait:
- dependency timings:
- worker/pool saturation:

Timeout budget:
- client:
- load balancer/CDN:
- Nginx:
- app handler:
- dependency clients:

Hypothesis:
- timed-out phase:
- evidence:

Fix:
- code/config/capacity change:
- validation command:
```

The note should make the failure reproducible. If the hypothesis says "Nginx timeout too low", the evidence should show a legitimate endpoint that completes reliably just beyond the current timeout and a full budget that can safely support the longer wait.

## References

- [RFC 9110, section 15.6.5: 504 Gateway Timeout](https://www.rfc-editor.org/rfc/rfc9110.html#name-504-gateway-timeout)
- [NGINX `ngx_http_proxy_module`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [NGINX `proxy_connect_timeout` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_connect_timeout)
- [NGINX `proxy_send_timeout` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_send_timeout)
- [NGINX `proxy_read_timeout` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout)
- [NGINX `proxy_next_upstream` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream)
- [NGINX upstream embedded variables](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#variables)
- [NGINX logging guide and upstream timing variables](https://docs.nginx.com/nginx/admin-guide/monitoring/logging/)
