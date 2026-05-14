---
title: 'Why "socket hang up" happens'
description: Learn what socket hang up usually means in backend clients and how to trace whether the peer, proxy, or application closed the connection first.
slug: socket-hang-up
publishedAt: 2026-05-14
tags:
  - sockets
  - backend
  - networking
related:
  - connection-reset-by-peer
  - broken-pipe
---

`socket hang up` usually means the connection was closed unexpectedly before the request or response completed. The exact meaning depends on the runtime, but the practical diagnosis is similar: determine who closed the connection first and why.

## What it means

The socket lifecycle ended earlier than the application expected. In many server-side runtimes, this appears when the peer resets the connection, a proxy cuts the stream, or the application pipeline aborts mid-flight.

## Common causes

- The upstream service closed the connection early.
- A proxy or load balancer enforced an idle timeout.
- The client and server disagreed on protocol or payload framing.
- The application hit an internal error and aborted the connection.

## How to diagnose it

Focus on the timeline around the disconnect.

1. Compare client logs with server and proxy logs.
2. Check whether the failure happens before or after response headers.
3. Inspect timeouts and keep-alive behavior across the path.
4. Capture packets if the disconnect source is unclear.

## Commands to try

```bash
curl -v https://<host>
ss -tanp
tcpdump -nn host <peer-ip>
journalctl -u your-service --since -15m
```

## How to fix it

Align timeout values, correct protocol handling, and remove the condition that causes the peer or proxy to close the connection early. If the app aborts the stream internally, fix that code path instead of masking the symptom.

## FAQ

### Is socket hang up always a network issue?

No. It often points to application or proxy behavior rather than a broken network path.

### Is it the same as broken pipe?

They are related but not identical. One usually describes an unexpected disconnect, while the other describes a failed write after the disconnect.

## Short checklist

- Determine who closed the connection first
- Compare logs across client, proxy, and server
- Check timeout and keep-alive alignment
