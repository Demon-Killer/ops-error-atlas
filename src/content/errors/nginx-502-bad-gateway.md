---
title: 'How to fix "502 Bad Gateway" from Nginx'
description: A practical Nginx 502 guide that separates down upstreams, wrong proxy targets, protocol mismatch, early closes, malformed responses, and deploy-time failures.
slug: nginx-502-bad-gateway
publishedAt: 2026-04-29
updatedAt: 2026-05-26
tags:
  - Nginx
  - HTTP
  - reverse-proxy
related:
  - upstream-prematurely-closed-connection
  - nginx-upstream-timed-out
  - nginx-host-not-found-in-upstream
  - nginx-504-gateway-timeout
  - connection-refused
---

`502 Bad Gateway` from Nginx is not a diagnosis. It is a boundary marker: the client reached Nginx, Nginx acted as a gateway or reverse proxy, and the upstream side did not produce a response Nginx could use.

RFC 9110 defines `502 Bad Gateway` as a gateway/proxy receiving an invalid response from an inbound server while trying to fulfill the request. In an Nginx stack, "invalid" is broader than "bad JSON" or "bad application body". It can mean connection failure, TLS handshake failure, an upstream that closes before headers, malformed HTTP response headers, oversized response headers, or a retry path that exhausts all usable upstreams.

Treat the incident as an upstream exchange failure. The useful question is:

```text
Which upstream phase failed: select target, connect, TLS handshake, send request, read response headers, parse response headers, or finish response body?
```

That framing prevents the common mistake of changing random Nginx timeout and buffer settings before proving what actually failed.

## The request path

Most production cases look like this:

```text
client -> load balancer / CDN -> Nginx -> upstream service
```

The browser or API client sees `502`. Nginx might be healthy. The upstream service might also be partially healthy. The failure can live in the narrow interaction between them: a wrong `proxy_pass` target, a container DNS name that resolves differently from the Nginx host, a TLS virtual host that requires SNI, a service that accepts the TCP connection and then dies before sending headers, or a deployment that removes workers without draining existing requests.

Your first job is not to "fix Nginx". Your first job is to make the upstream exchange observable.

## Start with the exact error log phrase

Nginx error logs usually contain the first high-signal clue. Do not group every 502 into the same bucket.

| Nginx error phrase | What failed first | First checks |
| --- | --- | --- |
| `connect() failed (111: Connection refused) while connecting to upstream` | TCP connection was actively refused | Wrong host/port, no listener, service restarted, container port not published |
| `no live upstreams while connecting to upstream` | Nginx could not select a usable upstream peer | Upstream block, DNS/service discovery, health state, all peers marked unavailable |
| `upstream prematurely closed connection while reading response header from upstream` | Upstream accepted the request path but closed before complete headers | App crash, worker restart, timeout inside app, graceful shutdown bug, proxy protocol mismatch |
| `upstream sent invalid header while reading response header from upstream` | Nginx received bytes that are not a valid HTTP response header | Wrong protocol, malformed header, raw TCP service behind HTTP proxy, application/framework bug |
| `upstream sent too big header while reading response header from upstream` | Response header did not fit the configured first-header buffer | Large cookies/auth headers, excessive `Set-Cookie`, framework header bloat, then buffer sizing |
| `SSL_do_handshake() failed` | Nginx failed while establishing TLS to an HTTPS upstream | Wrong scheme, missing SNI, certificate verification/trust chain, mTLS config, TLS protocol/cipher mismatch |
| `recv() failed ... while reading response header from upstream` | Connection broke while Nginx was waiting for headers | Upstream crash/restart, connection reset, network device reset, app closed after accepting |

If the error phrase says `connection refused`, start at listener and routing. If it says `invalid header`, start at protocol and response bytes. If it says `prematurely closed`, start at upstream process lifecycle and application logs.

## Add the access log fields that make 502 debuggable

Default combined logs are usually too weak for 502 incidents. Add upstream address, status, and timing fields so every failed request has enough evidence to separate connect failures from header delays and body transfer failures.

Example log format:

```nginx
log_format upstream_debug
  '$remote_addr request_id=$request_id '
  '"$request" status=$status bytes=$body_bytes_sent '
  'rt=$request_time '
  'uaddr="$upstream_addr" ustatus="$upstream_status" '
  'uct="$upstream_connect_time" uht="$upstream_header_time" urt="$upstream_response_time" '
  'host="$host" uri="$request_uri"';

access_log /var/log/nginx/access.log upstream_debug;
```

Read these fields carefully:

- `$upstream_addr` shows the selected upstream address. With retries, it can contain multiple addresses.
- `$upstream_status` shows the status code Nginx received from upstream, if any.
- `$upstream_connect_time` isolates time spent establishing the upstream connection.
- `$upstream_header_time` covers the interval from connection establishment to first response header byte.
- `$upstream_response_time` covers the interval from connection establishment to the last upstream response body byte.
- `$request_time` covers the total request processing time from Nginx's perspective.

NGINX documents these timing values as seconds with millisecond resolution. It also documents that multiple upstream attempts can be separated by commas, and that `0` or `-` can appear when no full upstream header is received or an upstream connection cannot be established. That means a single timing field is not enough; interpret it together with `$upstream_addr`, `$upstream_status`, and the error log line at the same timestamp.

## Fast triage flow

Use this flow before changing config:

1. Copy one failing request's exact error log line.
2. Identify the upstream address Nginx selected for that request.
3. Test that same host, port, scheme, and path from the same network namespace as Nginx.
4. Compare Nginx error log, Nginx access log, and upstream application logs at the same timestamp.
5. Check recent deploys, restarts, health-check transitions, and config reloads.
6. Only then decide whether the fix belongs in service discovery, app lifecycle, TLS, protocol selection, headers, or Nginx retry policy.

The phrase "same network namespace" matters. If Nginx runs inside a container or Kubernetes pod, a successful `curl` from your laptop proves almost nothing about what Nginx can reach. Run the test from the Nginx host, container, pod, or an equivalent debug pod in the same namespace and network policy context.

## Commands that usually find the branch

### Inspect the active Nginx config

```bash
nginx -T | grep -E 'proxy_pass|upstream|server |listen|resolver|proxy_ssl|proxy_next_upstream|proxy_buffer|proxy_read_timeout'
```

Look for the specific target Nginx will use:

- Does `proxy_pass` use `http://` or `https://`?
- Is the port the upstream actually listens on?
- Does the upstream name resolve inside the Nginx environment?
- Is there a path rewrite caused by a trailing slash or URI in `proxy_pass`?
- Are retries enabled through `proxy_next_upstream`?
- Are TLS settings present for an HTTPS upstream?

NGINX's `proxy_pass` directive sets the protocol and address of the proxied server. That means the scheme in `proxy_pass` is not cosmetic. `proxy_pass http://service:443` and `proxy_pass https://service:443` are different protocols.

### Test the upstream from where Nginx runs

```bash
curl -v --max-time 5 http://upstream-service:8080/health
curl -vk --max-time 5 https://upstream-service:8443/health
```

Use the same scheme, hostname, port, and path from `nginx -T`. Do not substitute a public URL unless Nginx also uses that public URL as its upstream.

If Nginx runs in Docker:

```bash
docker exec -it nginx-container sh
curl -v http://upstream-service:8080/health
```

If Nginx runs in Kubernetes:

```bash
kubectl exec -it deploy/nginx -- sh
curl -v http://upstream-service.namespace.svc.cluster.local:8080/health
```

If the image does not include `curl`, use a temporary debug pod in the same namespace and network policy scope.

### Check whether the upstream is listening

On the upstream host or container:

```bash
ss -ltnp
ss -tanp | grep ':8080'
```

For a `connect() failed (111: Connection refused)` error, this is a first-class check. A refused connection usually means the network path reached a host, but no process accepted the target TCP port or the host actively rejected it.

### Check logs at the same timestamp

```bash
journalctl -u nginx --since -30m
journalctl -u your-service --since -30m
tail -200 /var/log/nginx/error.log
tail -200 /var/log/nginx/access.log
```

Correlate by timestamp and request ID when possible. If you do not have a request ID yet, add one. Without correlation, it is easy to mistake a different upstream failure for the request you are debugging.

### Inspect TLS to an HTTPS upstream

```bash
openssl s_client -connect upstream.example.com:443 -servername upstream.example.com -showcerts
```

This checks the TLS handshake path and makes SNI explicit. If the upstream hosts multiple certificates behind the same IP, omitting `-servername` can test a different virtual host than Nginx should use.

## Case 1: Wrong target or upstream not listening

Strong signals:

- Nginx logs `connect() failed`.
- Direct `curl` from the Nginx environment fails immediately.
- `ss -ltnp` on the upstream does not show a listener.
- A service restart, failed deployment, or wrong port change happened near the first 502.

Fix path:

1. Confirm the service is actually bound to the expected interface and port.
2. Confirm Nginx points to the internal service address, not a stale hostname or an external URL that loops back through another proxy.
3. Confirm container port publishing or Kubernetes Service target port.
4. Reload Nginx only after `nginx -t` passes.

Examples of configuration mistakes:

```nginx
# Wrong if the app listens on 8080.
proxy_pass http://app:80;

# Wrong if the service only accepts HTTPS.
proxy_pass http://app:443;

# Risky if "localhost" means the Nginx container, not the app container.
proxy_pass http://127.0.0.1:8080;
```

The `127.0.0.1` case is common in containers: inside the Nginx container, `127.0.0.1` is the Nginx container itself, not another application container.

## Case 2: HTTP/HTTPS protocol mismatch

Protocol mismatch is one of the fastest ways to produce a confusing 502 because the port can be open and the upstream can be healthy, yet the bytes do not form the protocol Nginx expects.

Strong signals:

- `curl -v http://host:443/` prints TLS-looking binary output or "empty reply".
- `curl -vk https://host:80/` fails during handshake or receives plain HTTP.
- Nginx logs `upstream sent invalid header` or TLS handshake errors.
- The upstream recently moved TLS termination from the load balancer to the service, or the reverse.

Fix the upstream contract, not just the symptom:

```nginx
# Plain HTTP upstream.
proxy_pass http://app:8080;

# HTTPS upstream.
proxy_pass https://app.example.internal:443;
proxy_ssl_server_name on;
proxy_ssl_name app.example.internal;
```

`proxy_ssl_server_name on` enables SNI when Nginx connects to a proxied HTTPS server. `proxy_ssl_name` can override the name used for certificate verification and SNI. Use these deliberately when the upstream certificate and virtual host name differ from the raw service address.

Do not set `proxy_ssl_verify off` as a reflex. It can help prove that certificate verification is the failing branch, but leaving verification disabled turns a diagnostic shortcut into a security downgrade. If certificate verification is required, configure the trusted CA and expected name explicitly.

## Case 3: Upstream closes before sending response headers

`upstream prematurely closed connection while reading response header from upstream` means Nginx had reached the upstream side and was waiting for response headers, but the upstream closed too early.

Common causes:

- Application worker crashed or was killed.
- A deploy restarted workers before they drained in-flight requests.
- The app timed out internally and closed the socket without returning a valid HTTP response.
- A process manager killed the worker after a memory limit or startup timeout.
- A streaming endpoint raised an exception before headers were committed.
- Keepalive reuse hit a backend connection that the upstream was already closing.

Useful checks:

```bash
journalctl -u your-service --since -30m
dmesg -T | grep -Ei 'killed process|oom|segfault'
grep -R "panic\\|fatal\\|uncaught\\|OutOfMemory\\|SIGTERM" /var/log/your-service/
```

For Kubernetes, inspect lifecycle and readiness evidence:

```bash
kubectl describe pod <pod>
kubectl logs <pod> --previous
kubectl get events --sort-by=.lastTimestamp
kubectl rollout history deploy/<deployment>
```

The fix is usually upstream lifecycle work:

- Make readiness checks return ready only after the app can handle real proxied requests.
- On shutdown, fail readiness first, stop accepting new work, drain in-flight requests, then exit.
- Set a termination grace period that matches the app's real shutdown behavior.
- Return an explicit 5xx response if the app detects an internal timeout before headers, instead of dropping the connection.

## Case 4: Invalid or oversized response headers

Nginx parses the upstream response headers before it can send a normal response downstream. If the upstream sends bytes that are not a valid HTTP response header, Nginx can emit a 502. If the response header is valid but larger than the configured first-header buffer, Nginx can also reject it.

Strong signals:

- Error log says `upstream sent invalid header`.
- Error log says `upstream sent too big header`.
- Only specific endpoints fail, usually login, SSO, callback, or pages that set many cookies.
- Direct `curl -v` from the Nginx environment shows unusual header output.

Start by viewing the raw response:

```bash
curl -sv http://upstream-service:8080/problem-path -o /dev/null
```

Fix the source before tuning buffers:

- Remove invalid header characters or malformed header lines.
- Reduce excessive `Set-Cookie` usage.
- Avoid putting large session payloads into cookies.
- Check auth middleware that appends duplicate headers on redirects.
- Confirm the upstream is actually HTTP, not a raw TCP, gRPC-only, TLS-only, or FastCGI endpoint behind an HTTP proxy.

Only after the response is valid should you tune buffers:

```nginx
proxy_buffer_size 16k;
proxy_buffers 8 16k;
```

NGINX documents `proxy_buffer_size` as the buffer used for the first part of the proxied response, which usually contains response headers. If that first part exceeds the buffer, the response is considered invalid. That is why increasing the buffer can be a legitimate fix for genuinely large headers, but it is the wrong fix for malformed protocol bytes.

## Case 5: Retry policy hides the first failing upstream

`proxy_next_upstream` can make Nginx try another upstream when certain failures happen. The default includes `error` and `timeout`; the directive can also include cases such as `invalid_header`, `http_502`, `http_503`, and `http_504`.

This matters during debugging because the response the client receives might be the result of several upstream attempts, not one. Access logs can show comma-separated upstream addresses and timings when multiple peers were tried.

Check the active policy:

```bash
nginx -T | grep -A5 -B5 'proxy_next_upstream'
```

Use retry policy for resilience, not concealment:

- Keep retries safe for idempotent requests unless you have explicitly designed non-idempotent retry behavior.
- Do not retry POST/PATCH-style writes casually; duplicated side effects are worse than a visible 502.
- Cap tries and time if retry storms can amplify load during partial outages.
- Fix the failing peer instead of relying on retries to route around it forever.

NGINX documents that passing a request to the next server is only possible if nothing has been sent to the client yet. If the response breaks mid-transfer, retry cannot fully repair the client-visible result.

## Case 6: Deploy-time 502

Short 502 spikes around deployments are usually not "random Nginx behavior". They are often lifecycle coordination failures.

Typical pattern:

```text
old app worker receives request
deployment sends shutdown signal
worker exits before sending response headers
Nginx logs upstream prematurely closed connection
client sees 502
```

Production-grade deployment behavior should make this sequence impossible or rare:

- Readiness should fail before the worker stops accepting traffic.
- The load balancer or service mesh should stop routing new requests before termination.
- The worker should wait for in-flight requests or enforce a controlled graceful timeout.
- Nginx keepalive settings should not reuse backend connections that the app has already decided to close.
- Logs should expose shutdown reason, request ID, and whether the request died before or after response headers.

If 502s appear only during deploys, do not start by increasing `proxy_read_timeout`. A read timeout is not the same failure as an upstream process exiting before headers.

## 502 vs 504 vs 503

These codes are related but point to different first assumptions:

| Status | Practical meaning at a proxy | First branch |
| --- | --- | --- |
| `502 Bad Gateway` | Upstream response was unusable or upstream exchange failed | Protocol, connection, early close, invalid headers, TLS |
| `504 Gateway Timeout` | Proxy did not receive a timely upstream response | Slow upstream, blocked dependency, timeout budget |
| `503 Service Unavailable` | Service unavailable, overloaded, in maintenance, or no capacity | Capacity, health, admission control, maintenance |

A slow upstream can eventually produce 504. A crashing upstream can produce 502. An overloaded app may emit 503 intentionally. Mixing these leads to bad fixes.

## Decision tree

```text
Nginx returned 502
|
+-- error log says connect() failed?
|   |
|   +-- yes: test listener, host, port, routing, service discovery
|
+-- error log says SSL_do_handshake() failed?
|   |
|   +-- yes: check proxy_pass scheme, SNI, certificate trust, mTLS
|
+-- error log says invalid header?
|   |
|   +-- yes: check protocol mismatch and raw response headers
|
+-- error log says too big header?
|   |
|   +-- yes: verify header validity, reduce header size, then tune proxy_buffer_size
|
+-- error log says prematurely closed?
|   |
|   +-- yes: inspect upstream crash, restart, graceful shutdown, app timeout
|
+-- access log shows multiple upstream attempts?
    |
    +-- yes: inspect proxy_next_upstream and each peer's status/timing
```

## Evidence-based fixes

| Evidence | Likely fix |
| --- | --- |
| `connect() failed`, no listener | Start service, fix port, fix bind address, fix Service targetPort |
| `connect() failed`, listener exists | Check firewall, container network, DNS resolution, upstream address from Nginx namespace |
| `SSL_do_handshake() failed` | Match `https://` scheme, enable SNI when needed, configure CA/cert/mTLS correctly |
| `upstream sent invalid header` | Fix protocol mismatch or malformed application headers |
| `upstream sent too big header` | Reduce cookie/header bloat or tune `proxy_buffer_size` after validation |
| `upstream prematurely closed connection` | Fix app crash, deploy drain, worker shutdown, internal app timeout |
| Multiple upstreams tried, final 502 | Inspect each upstream attempt and retry policy; do not debug only the last address |

## What not to do first

- Do not restart Nginx before capturing one exact error log line.
- Do not increase every timeout because the client saw a 502.
- Do not increase buffers until you know the upstream response headers are valid.
- Do not test only from your laptop.
- Do not disable TLS verification permanently just to make a handshake error disappear.
- Do not add broad retries for non-idempotent requests without proving the app can tolerate duplicates.

## Minimal incident note template

Use this when handing the issue to another engineer:

```text
Symptom:
- Client-visible status:
- First seen:
- Affected route:

Nginx evidence:
- error.log phrase:
- upstream_addr:
- upstream_status:
- upstream_connect_time:
- upstream_header_time:
- upstream_response_time:
- request_id:

Direct upstream test from Nginx namespace:
- command:
- result:

Upstream evidence:
- app log line:
- deploy/restart/health event:

Current hypothesis:
- failed phase:
- why this evidence supports it:

Fix:
- config/app/deploy change:
- validation command:
```

The point is to make every 502 investigation reproducible. A good incident note should let another engineer replay the same branch without guessing.

## References

- [RFC 9110, section 15.6.3: 502 Bad Gateway](https://www.rfc-editor.org/rfc/rfc9110.html#name-502-bad-gateway)
- [NGINX `ngx_http_proxy_module`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [NGINX `proxy_pass` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)
- [NGINX `proxy_next_upstream` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream)
- [NGINX `proxy_ssl_server_name` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_ssl_server_name)
- [NGINX upstream embedded variables](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#variables)
- [NGINX logging guide and upstream timing variables](https://docs.nginx.com/nginx/admin-guide/monitoring/logging/)
