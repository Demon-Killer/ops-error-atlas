---
title: 'Why "socket hang up" happens'
description: A practical socket hang up guide for backend clients that separates peer resets, proxy timeouts, keepalive reuse, protocol mismatch, and application aborts.
slug: socket-hang-up
publishedAt: 2026-05-14
updatedAt: 2026-05-20
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

`socket hang up` means the connection closed before the request or response completed. In backend clients, especially Node.js services, it often appears when the peer resets the connection, a proxy cuts an idle stream, a keepalive connection is stale, or the application aborts the request pipeline.

## What it means

The socket lifecycle ended earlier than the runtime expected. The root cause may be outside the application process that reports the error.

Typical path:

```text
client library -> proxy/load balancer -> upstream service
```

Any hop can close first.

The useful question is not "which library printed the message?" The useful question is "which side made the connection unusable first, and at which phase?"

Important phases:

- before request bytes leave the client;
- while sending a request body;
- after the request is sent but before response headers;
- after response headers while streaming the body;
- after a connection sits idle in a keepalive pool.

Those phases point to different owners. A failure after a long idle period often belongs to keepalive lifetime mismatch. A failure while uploading a large body often belongs to proxy buffering, body-size limits, or upstream aborts. A failure during deploy windows often belongs to connection draining.

## Common causes

- Upstream process crashed or restarted.
- Proxy or load balancer enforced an idle timeout.
- Client reused a stale keepalive connection.
- HTTPS was sent to an HTTP port, or the reverse.
- Server closed because request headers, body, or framing were invalid.
- Application code aborted the request internally.

## First classify the failure phase

Use timestamps and byte counts before changing configuration.

| Phase | What to look for | Better first action |
| --- | --- | --- |
| before request write | DNS, connect, TLS, stale pooled socket | test without keepalive and inspect client agent settings |
| during request body | upload size, client abort, proxy body buffering | compare request size and proxy body limits |
| before response headers | upstream handler latency, crash, restart | check upstream access/error logs for the same request ID |
| during response body | streaming stall, proxy buffering, slow downstream | inspect chunk timing and response size |
| after idle reuse | keepalive timeout mismatch | align client socket lifetime below server idle timeout |

If you cannot identify the phase, add request IDs and log request start, write completion, first response byte, response end, and socket close events.

## Fast triage order

1. Identify whether the error happens before headers, after headers, or during response body.
2. Compare client logs with proxy and upstream logs at the same timestamp.
3. Check if failures cluster after idle periods.
4. Test with keepalive disabled or `Connection: close`.
5. Capture packets if you need to prove who closed first.

## Commands to try

### Reproduce with curl

```bash
curl -v http://<host>:<port>/<path>
curl -H 'Connection: close' -v http://<host>:<port>/<path>
```

If `Connection: close` changes behavior, suspect stale keepalive reuse.

For HTTPS, verify that the scheme and port are correct:

```bash
curl -v https://<host>:443/<path>
curl -v http://<host>:80/<path>
```

Protocol mistakes can look like random socket closes when one side speaks TLS and the other side expects plaintext HTTP.

### Check sockets and service logs

```bash
ss -tanp
journalctl -u your-service --since -30m
journalctl -u nginx --since -30m
```

### Check whether failures follow idle reuse

```bash
curl -v --no-keepalive http://<host>:<port>/<path>
curl -v --http1.1 -H 'Connection: close' http://<host>:<port>/<path>
```

If disabling reuse makes the error disappear, do not stop at "keepalive is bad." The real fix is usually to make the client retire idle sockets earlier than the proxy or upstream.

### Capture close behavior

```bash
tcpdump -nn -i any host <peer-ip> and port <port>
```

Look for `RST`, `FIN`, and which side sends the first close.

If TLS is involved, packet capture will not show HTTP content, but it still shows whether the close was a TCP reset, a graceful FIN, or silence followed by timeout.

## How to interpret signals

| Signal | Likely direction |
| --- | --- |
| happens after idle period | keepalive or idle timeout mismatch |
| happens during deploy | missing connection draining or upstream restart |
| only one upstream instance fails | bad node or bad version |
| HTTPS/HTTP mismatch in curl output | protocol or port mistake |
| large responses fail | streaming, buffering, or timeout path |
| failures spike during deploy | missing drain, old workers killed too early |
| small requests work, uploads fail | body limit, buffering, or client abort path |

## Production-grade evidence chain

A good incident note should be able to answer:

1. Which request ID failed?
2. Did the client finish writing the request?
3. Did the proxy receive the full request?
4. Did the upstream log the request?
5. Did the upstream send response headers?
6. Which hop sent the first `RST` or `FIN`?
7. Was the socket reused from a keepalive pool?

Without that evidence, common fixes become guesswork. Increasing timeouts may hide the symptom while keeping the wrong close behavior in place.

## How to fix it

### If keepalive reuse is the trigger

- align idle timeouts across client, proxy, and upstream;
- reduce client keepalive lifetime below server idle timeout;
- temporarily disable keepalive to confirm the cause.

Good rule: the client should stop reusing idle sockets before the server or load balancer is allowed to close them. If the load balancer has a configured idle timeout, the client pool should retire sockets earlier than that timeout, not later.

### If upstream closes early

- inspect app crashes and restarts;
- check deploy draining;
- compare healthy and unhealthy upstream nodes.

For rolling deploys, make sure the old instance stops accepting new requests, waits for active requests to finish, and only then exits. Killing workers immediately can turn normal deploys into waves of `socket hang up` errors.

### If protocol mismatch is the trigger

- verify scheme, port, and TLS termination point;
- ensure each hop speaks the protocol it expects.

### If app code aborts internally

- handle cancellation explicitly;
- stop downstream work after abort;
- log abort reason close to the source.

In Node.js services, log `req.aborted`, response close events, upstream request errors, and timeout handlers separately. Treating all of them as the same "socket hang up" event makes later debugging much harder.

## What not to do

- Do not blindly raise every timeout. First prove whether the close is idle, mid-body, or before headers.
- Do not permanently disable keepalive unless you accept the capacity cost.
- Do not retry non-idempotent requests without an idempotency key.
- Do not assume the peer is the application server; the first closer may be a proxy, load balancer, NAT, or client.

## Short checklist

- Determine whether close happens before headers, after headers, or mid-body.
- Compare client, proxy, and upstream logs.
- Test with `Connection: close`.
- Check deploy and idle timeout windows.
- Use packet capture to prove who closed first when logs disagree.
- Fix the phase-specific cause instead of treating `socket hang up` as one generic error.
