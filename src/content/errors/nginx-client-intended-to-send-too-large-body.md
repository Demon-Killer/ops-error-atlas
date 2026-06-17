---
title: 'How to fix Nginx "client intended to send too large body"'
description: A practical Nginx client intended to send too large body guide that separates upload limits, route-specific sizing, buffering, app limits, ingress limits, and unsafe global increases.
slug: nginx-client-intended-to-send-too-large-body
publishedAt: 2026-06-17
updatedAt: 2026-06-17
tags:
  - Nginx
  - HTTP
  - uploads
related:
  - nginx-499-client-closed-request
  - nginx-504-gateway-timeout
  - nginx-upstream-timed-out
  - read-connection-timed-out
---

`client intended to send too large body` means Nginx rejected a request body because it exceeded the configured `client_max_body_size`. The client may see `413 Request Entity Too Large` or a generic upload failure depending on the client and proxy chain.

The useful question is:

```text
Which route should accept this upload size, and which layer rejected it first?
```

Do not set a very large global upload limit before proving which endpoint needs it.

## Preserve the error line and request context

Search the error log:

```bash
grep -i "client intended to send too large body" /var/log/nginx/error.log
```

Keep:

```text
client IP:
server name:
request path:
Content-Length:
configured limit:
timestamp:
```

Then check the access log:

```bash
grep '<path-or-request-id>' /var/log/nginx/access.log
```

If the request never reached the upstream application, application logs will not explain the first failure.

## Find the active Nginx limit

Dump effective config:

```bash
nginx -T | grep -n "client_max_body_size"
```

Nginx config inheritance matters. `client_max_body_size` can appear at `http`, `server`, or `location` level. The most specific matching context wins.

Example route-specific configuration:

```nginx
location /api/uploads/ {
    client_max_body_size 25m;
}
```

Prefer route-specific limits over raising the global limit for the whole site.

## Check every proxy layer

The first visible Nginx may not be the only limit.

Common layers:

- CDN;
- cloud load balancer;
- Nginx ingress controller;
- edge Nginx;
- internal Nginx;
- application framework;
- object storage presigned upload policy.

If you raise one limit and the upload still fails, another layer may reject the body later.

For Kubernetes ingress-nginx, the relevant annotation is often:

```yaml
nginx.ingress.kubernetes.io/proxy-body-size: "25m"
```

Verify the generated config when possible.

## Case 1: Legitimate upload endpoint

Strong signals:

- route is explicitly designed for uploads;
- clients send images, logs, backups, exports, or package artifacts;
- request sizes are known and bounded;
- business requirement supports the size.

Fix path:

- set a route-specific limit;
- document the maximum upload size in API docs or UI;
- align Nginx, CDN, ingress, app framework, and storage limits;
- add client-side validation to fail early.

## Case 2: Unexpected large request

Strong signals:

- upload route is not supposed to accept large bodies;
- one client sends accidental huge JSON payloads;
- request body contains repeated fields or base64 data;
- a bug retries by appending data;
- bot traffic probes upload limits.

Fix path:

- keep or lower the limit;
- return a clear 413;
- log request path and size;
- fix the client payload shape;
- avoid allowing large bodies on unrelated routes.

## Case 3: Large JSON or base64 payload

Large API bodies are often a design problem rather than just a proxy setting.

Strong signals:

- request is JSON, not file upload;
- binary data is base64 encoded in JSON;
- one request contains thousands of records;
- retries resend the full body.

Fix path:

- upload binary data separately;
- use pagination or batch limits;
- send references to object storage;
- prefer resumable uploads for large files;
- reject oversize JSON with a clear error.

## Buffering and timeout side effects

Raising body limits can expose other problems:

- more disk buffering in Nginx temp paths;
- slower upstream requests;
- client disconnects during long uploads;
- request body timeout;
- disk pressure on proxy nodes.

Check:

```bash
df -h
nginx -T | grep -nE 'client_body|proxy_request_buffering|client_body_timeout'
```

If large uploads are expected, decide whether Nginx should buffer them fully or stream them to the upstream, and check whether the upstream can handle streaming safely.

## What not to do

- Do not set `client_max_body_size 0` globally without a clear reason.
- Do not raise only Nginx if CDN, ingress, or app limits remain lower.
- Do not accept large JSON bodies because uploads are easier to implement that way.
- Do not ignore proxy disk usage after increasing body limits.
- Do not treat every 413 as a bug; some large requests should be rejected.

## Decision tree

```text
client intended to send too large body
|
+-- which path and Content-Length?
|   +-- preserve error and access log
|
+-- route should accept this size?
|   +-- no -> keep limit and return clear 413
|
+-- all proxy/app/storage limits aligned?
|   +-- no -> update the rejecting layer
|
+-- large JSON/base64?
|   +-- redesign payload or batch/upload separately
|
+-- upload expected and bounded?
    +-- set route-specific client_max_body_size and verify disk/timeouts
```

## Minimal incident note

```text
error log line:
request path:
Content-Length:
expected maximum:
active client_max_body_size:
CDN/load balancer/ingress limits:
app framework limit:
body type:
buffering behavior:
fix:
verification:
```

The incident is solved when the accepted maximum is intentional, every layer enforces the same policy, and clients receive a predictable response when they exceed it.

## References

- [Nginx core module: client_max_body_size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)
- [Nginx core module: client_body_timeout](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_body_timeout)
- [ingress-nginx annotations](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/)
