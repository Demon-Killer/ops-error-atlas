---
title: 'How to fix "502 Bad Gateway" from Nginx'
description: A practical Nginx 502 guide that separates down upstreams, wrong proxy targets, protocol mismatch, early closes, malformed responses, and deploy-time failures.
slug: nginx-502-bad-gateway
publishedAt: 2026-04-29
updatedAt: 2026-05-19
tags:
  - Nginx
  - HTTP
  - reverse-proxy
related:
  - upstream-prematurely-closed-connection
  - nginx-upstream-timed-out
  - nginx-504-gateway-timeout
  - connection-refused
---

`502 Bad Gateway` from Nginx means Nginx received no usable response from the upstream side. The upstream may be down, listening on a different address, speaking the wrong protocol, closing the connection too early, or returning a response Nginx cannot parse.

## What it means

The request path usually looks like this:

```text
client -> Nginx -> upstream service
```

A 502 says the client reached Nginx, but Nginx could not complete the upstream exchange successfully. Nginx might be perfectly healthy while the service behind it is not.

## Start with the exact Nginx error

The error log usually points to the failure type:

| Nginx error phrase | First direction to check |
| --- | --- |
| `connect() failed (111: Connection refused)` | upstream not listening or wrong host/port |
| `no live upstreams` | upstream pool health or config |
| `upstream prematurely closed connection` | app crash, restart, keepalive, early close |
| `upstream sent invalid header` | malformed response or wrong protocol |
| `SSL_do_handshake() failed` | HTTPS/TLS mismatch to upstream |

Do not debug all 502s the same way. The error phrase decides the first branch.

## Common causes

- The upstream service is down, restarting, or not listening.
- Nginx points to the wrong host, port, scheme, or container network name.
- Nginx expects HTTP but the upstream expects HTTPS, or the reverse.
- The upstream closes the connection before sending valid headers.
- The upstream returns malformed headers or too-large headers.
- A deploy terminated workers before draining existing connections.

## Fast triage flow

1. Copy the exact Nginx error log line.
2. Test the upstream directly from the Nginx host.
3. Confirm host, port, scheme, and path in `nginx -T`.
4. Check whether the upstream process is listening.
5. Compare upstream app logs at the same timestamp.
6. Check deploys, restarts, and health-check failures.

## Commands to try

### Inspect Nginx config

```bash
nginx -T | grep -E 'proxy_pass|upstream|server |listen|ssl'
```

Look for mismatches such as:

- `proxy_pass http://...` when the upstream expects HTTPS;
- wrong port;
- wrong container hostname;
- stale upstream target.

### Test upstream from the Nginx host

```bash
curl -v http://upstream-service:port/
curl -vk https://upstream-service:port/
```

Test the same scheme and port that Nginx uses.

### Check whether the upstream is listening

```bash
ss -ltnp
ss -tanp | grep '<upstream-port>'
```

If Nginx logs `connection refused`, this is one of the first checks.

### Check recent logs

```bash
journalctl -u nginx --since -30m
journalctl -u your-service --since -30m
tail -200 /var/log/nginx/error.log
```

Look for restarts, crashes, panics, OOM kills, or invalid response errors.

### Check response headers manually

```bash
curl -v http://upstream-service:port/path
```

Malformed headers, empty responses, and protocol mismatch often show up immediately with verbose curl output.

## How to separate major cases

### Case 1: Upstream is unreachable or not listening

Strong signals:

- Nginx logs `connect() failed`;
- direct `curl` from Nginx host fails immediately;
- `ss -ltnp` shows no listener on the expected port.

Fix the listener, service address, container networking, or upstream config.

### Case 2: Protocol mismatch

Strong signals:

- HTTP client receives TLS-looking bytes;
- HTTPS client receives plain HTTP;
- `curl -v` shows handshake or protocol confusion;
- Nginx `proxy_pass` scheme does not match upstream behavior.

Fix the `proxy_pass` scheme and TLS termination design.

### Case 3: Upstream closes early

Strong signals:

- Nginx logs `upstream prematurely closed connection`;
- app logs show crash, restart, or timeout;
- packet capture shows upstream `RST` or early `FIN`.

Fix app shutdown, keepalive alignment, response streaming, or crash behavior.

### Case 4: Invalid or oversized headers

Strong signals:

- Nginx logs `upstream sent invalid header`;
- errors appear only on specific endpoints;
- large cookies or auth headers are involved.

Fix upstream header generation or tune header buffer settings only after confirming the response is valid.

## What not to do first

- Do not restart Nginx before testing the upstream.
- Do not assume 502 means Nginx is broken.
- Do not change buffer and timeout settings without the matching error phrase.
- Do not test from your laptop only; test from the Nginx host.

## How to fix it

### If the upstream is down

- restart or restore the upstream service;
- fix health checks;
- remove dead upstream targets from rotation.

### If the proxy target is wrong

- correct host, port, and scheme;
- verify service discovery or container DNS;
- reload Nginx after config validation.

### If the upstream response is invalid

- inspect response headers;
- fix app framework or middleware output;
- check protocol mismatch before increasing buffers.

### If deploys trigger 502s

- add graceful shutdown;
- drain load balancer targets before terminating workers;
- avoid killing workers with active connections.

## Related errors and how they differ

### `504 Gateway Timeout`

Nginx waited too long. A 502 often means the upstream response was broken or unavailable.

### `connection refused`

Usually points to no listener or active rejection during connection setup.

### `upstream prematurely closed connection`

Often one of the underlying causes of a 502.

## Short checklist

- Copy the exact Nginx error phrase.
- Test the upstream from the Nginx host.
- Confirm `proxy_pass` scheme, host, and port.
- Check upstream app logs for crashes, restarts, and invalid responses.
- Fix the upstream behavior before tuning Nginx settings.
