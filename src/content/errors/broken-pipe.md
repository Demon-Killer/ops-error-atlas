---
title: 'How to fix "broken pipe" in Linux applications'
description: Understand why broken pipe appears in Linux services and how to confirm whether the peer disconnected first.
slug: broken-pipe
publishedAt: 2026-05-12
tags:
  - Linux
  - sockets
  - services
related:
  - connection-reset-by-peer
  - connection-refused
---

`broken pipe` appears when your process writes to a socket or pipe after the other side has already closed it. The message is common in network services, background workers, and reverse-proxy setups.

## What it means

The write path is still active in your code, but the peer is gone. In socket terms, the remote side ended the connection before your process finished sending data.

## Common causes

- The client disconnected while the server was still sending a response.
- A proxy timed out and closed the connection.
- The application writes large responses too slowly.
- Backpressure or overload delayed the response until the peer gave up.

## How to diagnose it

Look for the first disconnect, not the final write failure. The write error is usually the last symptom.

1. Correlate timestamps between the service log and proxy log.
2. Check whether the error is isolated to one endpoint or payload size.
3. Inspect timeouts and keep-alive behavior.

## Commands to try

```bash
ss -tan state established
lsof -p <pid> | head
grep -R "timeout" /etc/nginx /etc/haproxy
journalctl -u your-service --since -15m
```

## How to fix it

Reduce response latency, increase timeouts where justified, and stop sending work after the connection is already closed. In long-polling or streaming paths, make disconnect handling explicit.

## FAQ

### Is broken pipe the same as connection reset by peer?

Not exactly. They are related symptoms, but one is a failed write attempt and the other usually points to a reset event from the peer.

### Does this mean the server is broken?

Not always. Sometimes the client disconnected because the user navigated away or a proxy timed out.

## Short checklist

- Find who disconnected first
- Compare response time with timeout settings
- Confirm whether large payloads trigger the issue more often
