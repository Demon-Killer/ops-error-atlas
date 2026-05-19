---
title: 'How to fix "broken pipe" in Linux applications'
description: A practical guide to broken pipe errors in Linux services, focused on finding who closed first, which write path failed, and how proxies, clients, and streaming responses trigger it.
slug: broken-pipe
publishedAt: 2026-05-12
updatedAt: 2026-05-19
tags:
  - Linux
  - sockets
  - services
related:
  - connection-reset-by-peer
  - connection-refused
  - upstream-prematurely-closed-connection
  - socket-hang-up
---

`broken pipe` means your process tried to write to a pipe or socket after the other side had already closed it. The write error is usually the last visible symptom. The useful question is: **who disconnected first, and why was your process still writing?**

## What it means

In network services, `broken pipe` often appears when:

- the client disconnected before the response finished;
- a proxy or load balancer timed out;
- the upstream service continued writing after a reset;
- a streaming response kept writing after the downstream went away.

At the system-call level, the write path fails because the receiving side is gone. That does not always mean your server is broken. It may mean the client, proxy, or middle layer gave up first.

## Common causes

- Users or clients cancel requests while the server is still responding.
- Nginx, HAProxy, or a load balancer closes an idle or slow connection.
- Large responses take longer than client or proxy timeouts.
- The application does not stop work after request cancellation.
- Streaming or long-polling code does not handle disconnects.
- The peer sends a TCP reset and the next write fails.

## Fast triage order

1. Find the first log line related to the request, not only the final `broken pipe`.
2. Compare timestamps across app, proxy, and client logs.
3. Check whether the error clusters by endpoint, payload size, or response time.
4. Look for `499` or client-abort logs in the proxy.
5. Capture packets if you need to prove whether the peer sent `FIN` or `RST`.

## How to separate likely causes

| Signal | Likely direction |
| --- | --- |
| Proxy logs `499` | Client closed before the server finished |
| Large responses fail more often | Slow writes, buffering, or downstream timeout |
| Errors appear after idle periods | Keepalive or idle timeout mismatch |
| App logs continue work after cancel | Missing cancellation handling |
| Packet capture shows peer `RST` | Peer or middlebox reset the connection |

## Commands to try

### Inspect active sockets

```bash
ss -tanp
ss -tan state established
```

### Check service and proxy logs

```bash
journalctl -u your-service --since -30m
journalctl -u nginx --since -30m
tail -200 /var/log/nginx/access.log
tail -200 /var/log/nginx/error.log
```

### Look for timeout configuration

```bash
nginx -T | grep -E 'timeout|keepalive|proxy_buffering'
grep -R "timeout" /etc/haproxy /etc/nginx 2>/dev/null
```

### Capture close behavior

```bash
tcpdump -nn -i any host <peer-ip> and port <port>
```

Look for which side sends `FIN` or `RST` first.

## How to fix it

### If clients disconnect first

- treat the error as expected noise if it is rare;
- stop expensive work when cancellation is detected;
- avoid logging full stack traces for normal client aborts.

### If proxies time out first

- align client, proxy, and upstream timeouts;
- reduce response latency before raising limits;
- inspect whether buffering or streaming behavior is correct.

### If large responses trigger it

- paginate or stream intentionally;
- flush safely and handle disconnects;
- reduce payload size where possible.

### If app code ignores cancellation

- wire request cancellation into downstream calls;
- stop DB/API work once the client is gone;
- make streaming loops check write errors and exit cleanly.

## Related errors and how they differ

### `connection reset by peer`

Often the event that happens before `broken pipe`. The peer resets the connection; your next write then fails.

### `socket hang up`

Common in Node.js when the remote side closes before the request completes.

### `upstream prematurely closed connection`

Nginx's view of an upstream closing too early. It can lead to broken writes on another hop.

## Short checklist

- Find who closed first.
- Check whether the failing endpoint is slow or large.
- Compare client/proxy/server timeout values.
- Treat rare client aborts differently from repeated upstream failures.
- Make long-running and streaming code cancellation-aware.
