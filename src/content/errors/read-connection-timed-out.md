---
title: 'Why "read: connection timed out" happens'
description: A practical read timeout guide that separates established connections, first-byte delay, stalled response bodies, packet loss, proxy idle timeouts, and upstream dependency latency.
slug: read-connection-timed-out
publishedAt: 2026-05-04
updatedAt: 2026-05-20
tags:
  - timeout
  - TCP
  - Linux
related:
  - io-timeout
  - curl-28-operation-timed-out
  - high-network-latency
  - tcp-retransmissions
---

`read: connection timed out` usually means the connection was established, but expected data did not arrive before the read deadline. This is different from DNS failure or TCP connect failure. The connection exists; the problem is that the next bytes were too late.

## What it means

A request can succeed at connection setup but still fail while reading:

```text
DNS -> TCP connect -> TLS -> request write -> response read
```

The read timeout lives near the end of that path. It may happen before the first byte, between response chunks, or while reading a long response body.

## Common causes

- Upstream application accepted the request but is slow to produce a response.
- Database, cache, or downstream API blocks the upstream.
- Packet loss delays response delivery.
- Proxy or firewall stalls idle flows.
- Response body streaming pauses longer than the read timeout.
- Timeout values are shorter than real p95 or p99 response latency.

## Fast triage order

1. Confirm TCP connect succeeds quickly.
2. Measure time to first byte.
3. Check whether the timeout happens before headers or during response body.
4. Compare client logs with upstream and proxy logs.
5. Inspect retransmissions and packet loss during the wait.
6. Check whether the endpoint is slow only under load.

## Commands to try

### Break down request timing

```bash
curl -s -o /dev/null \
  -w 'connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
  https://<host>/<path>
```

If `connect` is low but `first_byte` is high, the problem is usually upstream processing or a proxy path, not basic reachability.

### Check sockets and retransmissions

```bash
ss -ti
netstat -s | grep -Ei 'retrans|timeout'
```

### Capture the wait

```bash
tcpdump -nn -i any host <peer-ip> and port <port>
```

Use this to see whether packets stop, retransmit, or get reset.

### Compare service logs

```bash
journalctl -u your-service --since -30m
journalctl -u nginx --since -30m
```

## How to interpret signals

| Signal | Likely direction |
| --- | --- |
| connect fast, first byte slow | app, proxy, or dependency latency |
| response starts then stalls | streaming, buffering, or downstream slowness |
| retransmissions increase | packet loss or receiver pressure |
| only one endpoint fails | endpoint-specific app or dependency issue |
| failures cluster at exact idle duration | proxy or firewall idle timeout |

## How to fix it

### If first byte is slow

- profile the upstream handler;
- inspect DB/cache/API latency;
- add server-side timing logs.

### If response body stalls

- inspect streaming code;
- check proxy buffering;
- reduce large response payloads or flush intentionally.

### If packet loss is involved

- fix retransmissions, interface drops, or bad path;
- compare client and server packet captures.

### If idle timeout mismatch is involved

- align client, proxy, load balancer, and upstream read/idle timeouts;
- do not simply set all values very high.

## Short checklist

- Prove connect succeeds before debugging read timeout.
- Measure first byte separately from total time.
- Compare client-side wait with upstream logs.
- Check retransmissions during the stalled window.
- Tune read deadlines only after finding the slow phase.
