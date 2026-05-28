---
title: 'Why "socket hang up" happens'
description: A practical socket hang up guide for backend clients that separates peer resets, proxy timeouts, keepalive reuse, protocol mismatch, and application aborts.
slug: socket-hang-up
publishedAt: 2026-05-14
updatedAt: 2026-05-28
tags:
  - sockets
  - backend
  - networking
related:
  - connection-reset-by-peer
  - broken-pipe
  - upstream-prematurely-closed-connection
  - curl-28-operation-timed-out
---

`socket hang up` is most commonly seen in Node.js HTTP clients when the connection closes before the request/response exchange reaches the state the runtime expected. It is not a root cause. It is a symptom that a socket became unusable before the HTTP operation completed.

Node.js documents one important case explicitly: when a connection closes prematurely before a response is received, the request emits an error with message `Error: socket hang up` and code `ECONNRESET`. Node.js also documents `ECONNRESET` as "Connection reset by peer", meaning the connection was forcibly closed by the peer.

That does not mean the application server is always guilty. The "peer" from the client library's point of view might be:

- the upstream application;
- an Nginx or Envoy proxy;
- a load balancer;
- a service mesh sidecar;
- a NAT gateway or firewall;
- a client-side abort caused by your own timeout or `AbortController`;
- a stale socket reused from a keepalive pool.

The useful question is:

```text
Which hop closed first, during which HTTP phase, and was the socket fresh or reused?
```

Do not fix `socket hang up` by blindly increasing timeouts or disabling keepalive. First classify the phase.

## What "socket hang up" means in Node.js

In Node.js HTTP client code, the phrase often appears as:

```text
Error: socket hang up
code: ECONNRESET
```

High-value distinctions:

| Node.js observation | Meaning | First branch |
| --- | --- | --- |
| Error before `response` event | connection closed before response headers | upstream reset, proxy close, stale keepalive socket, protocol mismatch, local abort |
| `response` event happened, then response emits `aborted`/`ECONNRESET` | response started but body did not complete | stream abort, large response failure, proxy idle timeout, app crashed mid-body |
| request was destroyed or aborted by caller | local application canceled the request | timeout handler, `AbortController`, deadline propagation |
| `request.reusedSocket === true` on failure | socket came from keepalive pool | stale socket, idle timeout mismatch, unlucky server close |
| only fresh sockets fail | not primarily keepalive reuse | connect/TLS/protocol/server lifecycle branch |

This is why logging only `err.message` is weak. Log `err.code`, request phase, whether headers arrived, whether the socket was reused, bytes written, bytes read, and the target host/port.

## The request timeline

Place the failure on this timeline:

```text
create request
  -> get or reuse socket
  -> DNS / TCP connect / TLS handshake
  -> write request headers
  -> write request body
  -> receive response headers
  -> receive response body
  -> return socket to pool or close
```

Different phases imply different fixes:

| Phase | Common causes | Better first check |
| --- | --- | --- |
| before socket assignment | local abort, agent queue, request destroyed | app timeout/deadline code, client agent metrics |
| during connect/TLS | wrong host/port, TLS/SNI issue, firewall, refused/reset | `curl -v`, `openssl s_client`, connect timing |
| while writing request | large upload, upstream not reading, proxy body limit | request size, `Expect: 100-continue`, proxy/body logs |
| before response headers | upstream crash/restart, proxy timeout, protocol mismatch | upstream/proxy logs at same request ID |
| during response body | streaming stall, truncated response, deploy kill | body bytes, chunk timing, app stream logs |
| after idle reuse | stale keepalive socket | `request.reusedSocket`, agent settings, idle timeouts |

If you cannot place the failure on the timeline, add instrumentation before changing configuration.

## Log the evidence you need

For a Node.js HTTP client, log at least:

```js
import http from 'node:http';

const startedAt = Date.now();

const req = http.request(
  {
    hostname: 'upstream.internal',
    port: 8080,
    path: '/api/report',
    method: 'GET',
    agent,
  },
  (res) => {
    let bytes = 0;

    res.on('data', (chunk) => {
      bytes += chunk.length;
    });

    res.on('end', () => {
      console.log({
        event: 'upstream_response_end',
        statusCode: res.statusCode,
        bytes,
        durationMs: Date.now() - startedAt,
        reusedSocket: req.reusedSocket,
      });
    });

    res.on('aborted', () => {
      console.warn({
        event: 'upstream_response_aborted',
        statusCode: res.statusCode,
        bytes,
        durationMs: Date.now() - startedAt,
        reusedSocket: req.reusedSocket,
      });
    });
  },
);

req.on('socket', (socket) => {
  console.log({
    event: 'socket_assigned',
    localPort: socket.localPort,
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    reusedSocket: req.reusedSocket,
  });
});

req.on('error', (err) => {
  console.error({
    event: 'upstream_request_error',
    message: err.message,
    code: err.code,
    durationMs: Date.now() - startedAt,
    reusedSocket: req.reusedSocket,
    destroyed: req.destroyed,
  });
});

req.end();
```

This is example instrumentation, not a drop-in observability library. Adapt it to your HTTP client. If you use `fetch`, Axios, undici, gRPC, or a service mesh, keep the same fields: phase, target, timeout/deadline, reused connection, bytes, response state, and error code.

## Fast triage flow

Use this sequence:

1. Record one failing request with timestamp, target host/port, method, route, and request ID.
2. Determine whether response headers were received.
3. Check whether the socket was reused from a keepalive pool.
4. Match client logs with proxy and upstream logs at the same timestamp.
5. Test with a fresh connection using `Connection: close` or `agent: false`.
6. Test the exact scheme, port, SNI, and path with `curl` or `openssl`.
7. Use packet capture only when logs disagree about who closed first.

The goal is to prove the first closer. Without that, you are only guessing from a runtime error message.

## Commands that separate common branches

### Reproduce with curl

```bash
curl -v http://upstream-service:8080/path
curl -H 'Connection: close' -v http://upstream-service:8080/path
curl --http1.1 -H 'Connection: close' -v http://upstream-service:8080/path
```

If `Connection: close` changes the failure rate, suspect keepalive reuse or idle-timeout mismatch. Do not stop there. The fix is usually to align connection lifetimes, not to disable keepalive forever.

### Validate protocol and TLS

```bash
curl -v http://upstream-service:443/path
curl -vk https://upstream-service:443/path
openssl s_client -connect upstream-service:443 -servername upstream-service -showcerts
```

HTTP-to-HTTPS and HTTPS-to-HTTP mistakes often surface as abrupt socket closes because one side is speaking bytes the other side cannot parse.

### Check proxy and service logs

```bash
journalctl -u nginx --since -30m
journalctl -u your-service --since -30m
tail -200 /var/log/nginx/error.log
tail -200 /var/log/nginx/access.log
```

Look for the same request ID or timestamp. For Nginx, related clues include `upstream prematurely closed connection`, `connection reset by peer`, `client prematurely closed connection`, `upstream timed out`, and `invalid header`.

### Capture close direction

```bash
tcpdump -nn -tttt -i any host <peer-ip> and port <port>
ss -tanp | grep ':8080'
```

Packet capture cannot decrypt TLS payloads, but it can still show whether a connection ended with a graceful `FIN`, an abrupt `RST`, or silence followed by timeout. The direction matters.

## Case 1: Stale keepalive socket

Keepalive reuse is a high-value branch because it creates intermittent failures that are hard to reproduce with one-off tests.

Strong signals:

- failure happens after idle periods;
- `request.reusedSocket` is `true`;
- fresh connections usually work;
- `Connection: close` reduces or removes the symptom;
- packet capture shows the server or proxy closing an idle connection near the reuse moment.

Why it happens:

```text
client agent keeps an idle socket
server/load balancer closes it after its idle timeout
client reuses the socket at an unlucky moment
client receives ECONNRESET / socket hang up
```

Fix path:

- make the client retire idle sockets before the server or load balancer closes them;
- configure client agent free-socket lifetime and max-free-socket behavior deliberately;
- use `request.reusedSocket` to confirm the branch;
- avoid global keepalive disablement unless you accept the capacity cost;
- retry only when the operation is safe and the failure happened before the request had side effects.

Node.js documentation specifically calls out that a request through a keepalive-enabled agent may use a reused socket, and if the server closes the connection at an unfortunate time the client may see `ECONNRESET`.

## Case 2: Upstream or proxy closes before response headers

Strong signals:

- Node.js emits `socket hang up` before the `response` event;
- proxy logs show `upstream prematurely closed connection` or reset;
- upstream app logs show crash, restart, deploy, or worker kill;
- failures cluster by route, node, or deploy window.

Likely causes:

- application process crashed before writing response headers;
- deploy killed a worker without draining in-flight requests;
- upstream closed after internal timeout instead of returning a controlled 5xx;
- middle proxy reset the connection;
- protocol mismatch caused the peer to reject the stream.

Fix path:

1. Match request ID across client, proxy, and upstream logs.
2. Check app crash/restart/OOM/deploy events.
3. Confirm whether the upstream wrote response headers.
4. Add graceful shutdown and connection draining.
5. Return explicit 5xx responses for handled internal failures instead of dropping the socket.

If Nginx is between the client and app, this branch often pairs with the Nginx error `upstream prematurely closed connection`.

## Case 3: Response starts, then body aborts

This is different from a pre-header close. The client may have status and headers, but the response body is incomplete.

Strong signals:

- Node.js receives a `response` event first;
- response emits `aborted` or an `ECONNRESET`-related error later;
- bytes received are nonzero but less than expected;
- route serves downloads, exports, reports, or streams;
- failure correlates with large responses or long idle gaps between chunks.

Likely causes:

- streaming generator throws after headers are sent;
- export code fails while paging through a database;
- upstream app write timeout fires;
- proxy read/idle timeout closes a silent stream;
- deployment terminates the stream mid-body.

Fix path:

- make stream chunk timing visible in logs;
- avoid sending success headers before the operation has passed its main failure point;
- use background jobs and downloadable artifacts for long exports;
- send deliberate heartbeat chunks only when the protocol and clients support them;
- propagate client cancellation to expensive upstream work.

Once response headers are sent, clean error handling and retries become harder.

## Case 4: Protocol or port mismatch

Strong signals:

- the port is open but connections close immediately;
- `curl -v` shows TLS bytes on an HTTP request or plain HTTP on an HTTPS request;
- errors started after changing TLS termination, service port, or proxy route;
- only one environment or upstream target fails.

Examples:

```text
http client -> port 443 that expects TLS
https client -> port 80 that serves plaintext HTTP
HTTP/1.1 client -> gRPC-only HTTP/2 endpoint
normal HTTP proxy -> raw TCP service
```

Fix path:

- verify scheme, host, port, and TLS termination point;
- check SNI when the upstream hosts multiple certificates;
- ensure the proxy module matches the protocol;
- test from the same network namespace as the failing service.

Do not tune keepalive or retry policy until the protocol contract is correct.

## Case 5: Request body is rejected or abandoned

Strong signals:

- failures happen on uploads or large POST requests;
- small requests succeed;
- server logs show body-size limit, invalid framing, or request parse errors;
- client error appears while writing the request;
- Nginx or proxy logs mention request body read/send problems.

Likely causes:

- `client_max_body_size` or equivalent limit is lower than payloads;
- upstream application stops reading the body;
- request buffering behavior does not match the endpoint;
- client timeout fires while uploading;
- server rejects malformed chunked encoding or invalid headers.

Fix path:

- make request size limits explicit;
- separate large upload routes from normal API routes;
- use direct-to-object-storage upload patterns for large files;
- handle `Expect: 100-continue` deliberately if clients use it;
- log bytes written before failure.

## Case 6: Local application aborts its own request

Not every `socket hang up` comes from the remote side. Your service may destroy the request.

Strong signals:

- error occurs exactly at your configured timeout;
- logs show `AbortController`, deadline, context cancellation, or `req.destroy()`;
- no corresponding upstream error exists;
- the failure rate changes with caller deadlines.

Node.js documents that passing an `AbortSignal` and calling `abort()` behaves like destroying the request, with an abort error. Older code may still use `request.abort()`, which is deprecated in favor of `request.destroy()`.

Fix path:

- log local abort reason separately from remote reset;
- set a total deadline for the whole operation, including retries;
- avoid retrying after the caller deadline has expired;
- propagate cancellation to downstream work intentionally;
- distinguish user cancellation from dependency timeout.

If your code is the closer, the remote service may be innocent.

## Case 7: Deploy-time connection loss

Strong signals:

- errors cluster during rolling deploys, restarts, or autoscaling events;
- one upstream version or node dominates;
- server logs show shutdown while requests are in flight;
- load balancer target removal happens after process termination.

Fix path:

- fail readiness before stopping request acceptance;
- drain load balancer targets before killing workers;
- let in-flight requests finish within a controlled grace period;
- close idle keepalive connections deliberately during shutdown;
- log interrupted request IDs and shutdown reason.

Deploy-time `socket hang up` is usually a lifecycle bug, not random network behavior.

## Retry policy

Retries are useful only when the operation is safe and bounded.

Reasonable retry candidates:

- failure happened before the request was written;
- `request.reusedSocket` is true and the method is idempotent;
- the operation has an idempotency key;
- there is a total deadline across all attempts;
- retry uses backoff and does not target the same known-bad peer forever.

Unsafe retry candidates:

- POST/PATCH/write operation without idempotency protection;
- request body may have reached the upstream;
- upstream may have performed side effects before the reset;
- dependency is already saturated;
- retry would exceed the caller's deadline.

The common mistake is turning an intermittent reset into duplicate work.

## Decision tree

```text
socket hang up / ECONNRESET
|
+-- response event never fired?
|   |
|   +-- check stale keepalive, protocol mismatch, proxy close, upstream crash, local abort
|
+-- response started but body aborted?
|   |
|   +-- check streaming/export path, large response, proxy idle timeout, deploy kill
|
+-- request.reusedSocket is true?
|   |
|   +-- check client agent lifetime vs server/load balancer idle timeout
|
+-- failure during upload/write?
|   |
|   +-- check body limits, buffering, upstream body reads, client timeout
|
+-- errors cluster during deploy?
|   |
|   +-- check readiness, drain, graceful shutdown, worker termination
|
+-- logs disagree about who closed?
    |
    +-- use tcpdump to prove FIN/RST direction and timing
```

## What not to do

- Do not treat `socket hang up` as a single root cause.
- Do not disable keepalive permanently without measuring connection churn and upstream accept load.
- Do not raise every timeout before proving whether the socket was idle, mid-body, or pre-header.
- Do not retry non-idempotent requests without an idempotency key.
- Do not ignore protocol mismatch just because the port is open.
- Do not rely on laptop tests when production traffic uses a proxy, private network, or service mesh.

## Minimal incident note template

```text
Symptom:
- error message:
- error code:
- method/route:
- target host/port/scheme:
- first seen:

Client evidence:
- response event fired? yes/no
- bytes written:
- bytes read:
- reusedSocket:
- local timeout/deadline:
- request destroyed/aborted locally? yes/no

Proxy/upstream evidence:
- proxy error line:
- upstream access log:
- upstream error/restart/deploy event:
- response headers sent? yes/no

Connection evidence:
- curl with Connection: close:
- fresh socket test:
- tcpdump FIN/RST direction:

Hypothesis:
- first closer:
- phase:
- evidence:

Fix:
- code/config/lifecycle change:
- validation command:
```

The incident is understood only when you can name the first closer and the phase. Everything else is symptom treatment.

## References

- [Node.js HTTP documentation: premature close and `Error: socket hang up`](https://nodejs.org/api/http.html)
- [Node.js common system errors: `ECONNRESET`](https://nodejs.org/api/errors.html#common-system-errors)
- [Node.js HTTP documentation: `request.reusedSocket`](https://nodejs.org/api/http.html#requestreusedsocket)
- [Node.js HTTP agent keepalive options](https://nodejs.org/api/http.html#new-agentoptions)
- [NGINX `ngx_http_proxy_module`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [NGINX upstream keepalive directive](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive)
- [Linux `tcp(7)` manual page](https://man7.org/linux/man-pages/man7/tcp.7.html)
- [tcpdump manual page](https://www.tcpdump.org/manpages/tcpdump.1.html)
