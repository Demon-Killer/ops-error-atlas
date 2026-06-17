---
title: 'How to fix Nginx "upstream sent too big header"'
description: A practical Nginx upstream sent too big header guide that separates oversized response headers, cookies, redirects, auth tokens, proxy buffers, and unsafe global buffer increases.
slug: nginx-upstream-sent-too-big-header
publishedAt: 2026-06-17
updatedAt: 2026-06-17
tags:
  - Nginx
  - HTTP
  - reverse-proxy
related:
  - nginx-502-bad-gateway
  - upstream-prematurely-closed-connection
  - nginx-upstream-timed-out
  - nginx-504-gateway-timeout
---

`upstream sent too big header` means Nginx received response headers from an upstream server that did not fit inside the configured proxy buffer limits. The client often sees `502 Bad Gateway`, but the useful evidence is in the Nginx error log.

The common mistake is to raise every buffer globally without asking why the upstream produced such large headers. Sometimes a larger buffer is reasonable. Sometimes the real problem is a runaway cookie, a redirect loop, a huge authentication token, or an upstream response that is not what the route is supposed to return.

The useful question is:

```text
Which upstream response header exceeded the buffer, and is that header expected for this route?
```

## Preserve the exact Nginx error line

Start with the error log:

```bash
grep -i "upstream sent too big header" /var/log/nginx/error.log
```

Keep:

```text
timestamp:
client:
server:
request:
upstream:
host:
```

Then correlate with the access log around the same timestamp:

```bash
grep '<request-id-or-path>' /var/log/nginx/access.log
```

If your access log includes `$upstream_addr`, `$upstream_status`, `$request_time`, and `$upstream_response_time`, preserve those fields. They tell you which backend produced the oversized headers.

## Capture upstream headers directly

From the Nginx host or a comparable network namespace:

```bash
curl -sv -o /dev/null http://<upstream-host>:<port>/<path>
curl -sv -I http://<upstream-host>:<port>/<path>
```

If the upstream requires a Host header:

```bash
curl -sv -H 'Host: example.com' -o /dev/null http://<upstream-host>:<port>/<path>
```

Look for:

- many `Set-Cookie` headers;
- one extremely large cookie;
- large `Location` header;
- large `WWW-Authenticate` header;
- oversized custom headers;
- repeated headers caused by middleware stacking;
- response from the wrong upstream or route.

Do not test only the public Nginx URL. You need the upstream response headers that Nginx tried to read.

## Case 1: Cookie or session header growth

Strong signals:

- the failure appears after login, SSO, or a specific redirect;
- response contains many `Set-Cookie` headers;
- session state is stored in cookies;
- a feature rollout added claims, permissions, or user metadata to cookies;
- only some users fail.

Fix path:

- reduce cookie size;
- avoid storing large state client-side;
- remove duplicate cookies;
- check cookie domain/path causing multiple cookies to be sent together;
- review auth middleware that appends repeated headers.

Raising Nginx buffers may hide the symptom while leaving a cookie design problem that affects every request.

## Case 2: Large auth tokens or SSO headers

Strong signals:

- failures start after auth provider changes;
- ID tokens, JWTs, or group claims grew;
- upstream sets a large `Authorization`, `Set-Cookie`, or identity header;
- only users with many roles/groups fail.

Fix path:

- reduce token claims;
- use server-side sessions when appropriate;
- avoid passing large identity payloads through every proxy hop;
- test with users of different group counts.

When auth headers are the cause, buffer changes should be route-specific and backed by a token-size decision.

## Case 3: Redirect loops or large Location headers

Strong signals:

- `Location` header contains repeated query parameters;
- login callback URLs grow with each attempt;
- failing request is a redirect path;
- headers differ between HTTP and HTTPS termination paths.

Checks:

```bash
curl -sv -L --max-redirs 5 -o /dev/null https://example.com/path
curl -sv -o /dev/null https://example.com/path
```

Fix path:

- stop appending duplicate query parameters;
- fix callback URL generation;
- align proxy headers such as `X-Forwarded-Proto` and `Host`;
- check whether the app thinks it is behind HTTP while users arrive over HTTPS.

## Case 4: Wrong upstream route

Sometimes the oversized headers are not from the intended service.

Strong signals:

- upstream address differs from expectation;
- one backend version fails;
- a canary route returns a different app;
- health checks are green but one path goes to an auth gateway or error page.

Fix path:

- verify upstream pool membership;
- test each backend directly;
- preserve Host header when testing;
- remove stale or wrong targets.

## Buffer settings branch

Relevant directives include:

```nginx
proxy_buffer_size
proxy_buffers
proxy_busy_buffers_size
fastcgi_buffer_size
fastcgi_buffers
```

If evidence shows legitimate headers are larger than defaults, increase buffers narrowly:

```nginx
location /auth/callback {
    proxy_buffer_size 16k;
    proxy_buffers 8 16k;
}
```

Use this only after measuring real header sizes and understanding why they are large. Global increases raise memory use across many concurrent requests.

## What not to do

- Do not raise buffer sizes globally as the first move.
- Do not ignore cookies and auth tokens.
- Do not test only the public URL and skip upstream headers.
- Do not assume `502` means the upstream crashed.
- Do not miss one bad backend in a load-balanced pool.

## Decision tree

```text
upstream sent too big header
|
+-- which upstream and route?
|   +-- preserve error log and access log
|
+-- direct upstream headers are large?
|   +-- inspect Set-Cookie, Location, auth headers, custom headers
|
+-- only some users fail?
|   +-- inspect auth/session cookie size and group claims
|
+-- only one backend fails?
|   +-- inspect pool membership, version, route config
|
+-- headers are expected and bounded?
    +-- tune proxy buffers narrowly, then verify memory impact
```

## Minimal incident note

```text
error log line:
request path:
upstream address:
upstream status:
failing user/session type:
largest response headers:
cookie count and size:
auth provider change:
buffer directives:
confirmed cause:
fix:
verification:
```

The incident is solved when the upstream response header size is understood and Nginx either receives smaller headers or has a justified route-specific buffer configuration.

## References

- [Nginx proxy module: proxy_buffer_size](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffer_size)
- [Nginx proxy module: proxy_buffers](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffers)
- [Nginx log module documentation](https://nginx.org/en/docs/http/ngx_http_log_module.html)
