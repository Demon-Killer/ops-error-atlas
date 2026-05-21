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

The error is usually delayed. The peer may have closed seconds earlier, but your process only discovers it on the next write. That is why the last stack trace is rarely enough to identify the first failure.

## Common causes

- Users or clients cancel requests while the server is still responding.
- Nginx, HAProxy, or a load balancer closes an idle or slow connection.
- Large responses take longer than client or proxy timeouts.
- The application does not stop work after request cancellation.
- Streaming or long-polling code does not handle disconnects.
- The peer sends a TCP reset and the next write fails.

## Classify the write path

Before changing timeouts, identify what your process was writing:

```text
response headers:
small JSON body:
large file:
streaming chunks:
server-sent events:
proxy-to-upstream request body:
```

Each path has different owners. A large file failure may be slow-client behavior. A streaming failure may be missing cancellation handling. A proxy request-body failure may mean the upstream closed before the upload finished.

## Fast triage order

1. Find the first log line related to the request, not only the final `broken pipe`.
2. Compare timestamps across app, proxy, and client logs.
3. Check whether the error clusters by endpoint, payload size, or response time.
4. Look for `499` or client-abort logs in the proxy.
5. Capture packets if you need to prove whether the peer sent `FIN` or `RST`.
6. Check whether application work continues after the client is gone.

## How to separate likely causes

| Signal | Likely direction |
| --- | --- |
| Proxy logs `499` | Client closed before the server finished |
| Large responses fail more often | Slow writes, buffering, or downstream timeout |
| Errors appear after idle periods | Keepalive or idle timeout mismatch |
| App logs continue work after cancel | Missing cancellation handling |
| Packet capture shows peer `RST` | Peer or middlebox reset the connection |
| Errors cluster on exports/downloads | slow downstream or large response path |
| Errors spike during deploy | draining or worker shutdown issue |
| proxy has 499 at same timestamp | downstream closed before upstream response finished |

## Build a close-order timeline

For a real incident, reconstruct:

```text
request accepted
request body read
upstream call started
response headers written
response body write failed
proxy/client close logged
application work stopped
```

If the client closed first and the application continued expensive work, the operational bug is not the broken pipe itself. The bug is missing cancellation propagation.

## Commands to try

### Inspect active sockets

```bash
ss -tanp
ss -tan state established
```

Look for stuck send queues:

```bash
ss -tanp | awk '$2 != "0" || $3 != "0" {print}'
```

Large send queues can indicate a slow receiver or blocked downstream path.

### Check service and proxy logs

```bash
journalctl -u your-service --since -30m
journalctl -u nginx --since -30m
tail -200 /var/log/nginx/access.log
tail -200 /var/log/nginx/error.log
```

If Nginx is in the path, compare application errors with Nginx `499`, `$request_time`, and `$upstream_response_time` for the same request ID or timestamp.

### Look for timeout configuration

```bash
nginx -T | grep -E 'timeout|keepalive|proxy_buffering'
grep -R "timeout" /etc/haproxy /etc/nginx 2>/dev/null
```

Timeouts to compare:

```text
client timeout
load balancer idle timeout
proxy read/send timeout
upstream app timeout
dependency timeout
```

If the outer layer times out earlier than the inner layer, broken pipes are expected under slow responses.

### Capture close behavior

```bash
tcpdump -nn -i any host <peer-ip> and port <port>
```

Look for which side sends `FIN` or `RST` first.

`FIN` usually means graceful close. `RST` usually means abortive close. Both can lead to a later broken pipe when the application tries to write again.

## How to fix it

### If clients disconnect first

- treat the error as expected noise if it is rare;
- stop expensive work when cancellation is detected;
- avoid logging full stack traces for normal client aborts.

Track rate and endpoint. Rare user cancellations should not page the on-call engineer, but a sudden spike on a core API deserves investigation.

### If proxies time out first

- align client, proxy, and upstream timeouts;
- reduce response latency before raising limits;
- inspect whether buffering or streaming behavior is correct.

Do not only raise proxy timeouts. If the user-facing client will still abandon the request earlier, the system will continue wasting upstream work.

### If large responses trigger it

- paginate or stream intentionally;
- flush safely and handle disconnects;
- reduce payload size where possible.

For downloads, make sure partial transfer and resume behavior are intentional. For APIs, prefer pagination or asynchronous export jobs over keeping one request open for too long.

### If app code ignores cancellation

- wire request cancellation into downstream calls;
- stop DB/API work once the client is gone;
- make streaming loops check write errors and exit cleanly.

A good fix makes cancellation observable. Log whether a request stopped because the client disconnected, a dependency timed out, or the server canceled its own work.

## What not to do

- Do not treat every `broken pipe` as a server crash.
- Do not retry writes after the peer has gone away.
- Do not keep expensive downstream work running after request cancellation.
- Do not hide high-volume broken pipes by lowering log level without checking endpoint concentration.
- Do not assume the peer is the browser; it may be a proxy or load balancer.

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
- Prove who closed first before changing timeout values.
