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

## Common causes

- Upstream process crashed or restarted.
- Proxy or load balancer enforced an idle timeout.
- Client reused a stale keepalive connection.
- HTTPS was sent to an HTTP port, or the reverse.
- Server closed because request headers, body, or framing were invalid.
- Application code aborted the request internally.

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

### Check sockets and service logs

```bash
ss -tanp
journalctl -u your-service --since -30m
journalctl -u nginx --since -30m
```

### Capture close behavior

```bash
tcpdump -nn -i any host <peer-ip> and port <port>
```

Look for `RST`, `FIN`, and which side sends the first close.

## How to interpret signals

| Signal | Likely direction |
| --- | --- |
| happens after idle period | keepalive or idle timeout mismatch |
| happens during deploy | missing connection draining or upstream restart |
| only one upstream instance fails | bad node or bad version |
| HTTPS/HTTP mismatch in curl output | protocol or port mistake |
| large responses fail | streaming, buffering, or timeout path |

## How to fix it

### If keepalive reuse is the trigger

- align idle timeouts across client, proxy, and upstream;
- reduce client keepalive lifetime below server idle timeout;
- temporarily disable keepalive to confirm the cause.

### If upstream closes early

- inspect app crashes and restarts;
- check deploy draining;
- compare healthy and unhealthy upstream nodes.

### If protocol mismatch is the trigger

- verify scheme, port, and TLS termination point;
- ensure each hop speaks the protocol it expects.

### If app code aborts internally

- handle cancellation explicitly;
- stop downstream work after abort;
- log abort reason close to the source.

## Short checklist

- Determine whether close happens before headers, after headers, or mid-body.
- Compare client, proxy, and upstream logs.
- Test with `Connection: close`.
- Check deploy and idle timeout windows.
- Use packet capture to prove who closed first when logs disagree.
