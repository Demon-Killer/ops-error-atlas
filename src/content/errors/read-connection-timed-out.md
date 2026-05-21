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

That distinction matters because the owner changes:

- slow first byte usually points to upstream work, proxy queueing, or dependency latency, but confirm with server logs;
- slow body chunks usually point to streaming, buffering, receiver pressure, or downstream backpressure, but confirm with packet or application timing;
- repeated failures near the same duration often point to a configured timeout;
- variable-duration failures often point to resource contention or packet loss.

Do not treat every read timeout as "the network is slow." A read timeout is a symptom of no bytes arriving soon enough at a specific read point.

## Common causes

- Upstream application accepted the request but is slow to produce a response.
- Database, cache, or downstream API blocks the upstream.
- Packet loss delays response delivery.
- Proxy or firewall stalls idle flows.
- Response body streaming pauses longer than the read timeout.
- Timeout values are shorter than real p95 or p99 response latency.

## Build a timeout timeline

For production debugging, draw the request as a timeline:

```text
client start
  -> DNS resolved
  -> TCP connected
  -> TLS completed
  -> request fully written
  -> first response byte received
  -> response body completed
```

Then write the elapsed time at each point. The fix for a 10-second wait before first byte is different from a 10-second pause halfway through a 500 MB response.

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

Run it more than once:

```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null \
    -w "$i connect=%{time_connect} first_byte=%{time_starttransfer} total=%{time_total}\n" \
    https://<host>/<path>
done
```

One clean run does not disprove an intermittent read timeout.

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

For long-running responses, include timestamps:

```bash
tcpdump -tttt -nn -i any host <peer-ip> and port <port>
```

Timestamps help match the packet-level gap to the application read deadline.

### Compare service logs

```bash
journalctl -u your-service --since -30m
journalctl -u nginx --since -30m
```

If possible, compare access-log request time, upstream response time, and application handler timing. A client-side timeout with no upstream log suggests the request may not have reached the service. A client-side timeout with a long upstream duration suggests the service received it but did not produce bytes quickly enough.

## How to interpret signals

| Signal | Likely direction |
| --- | --- |
| connect fast, first byte slow | app, proxy, or dependency latency |
| response starts then stalls | streaming, buffering, or downstream slowness |
| retransmissions increase | packet loss or receiver pressure |
| only one endpoint fails | endpoint-specific app or dependency issue |
| failures cluster at exact idle duration | proxy or firewall idle timeout |
| first byte is fast, total is slow | body streaming or receiver-side slowness |
| app logs finish after client timeout | timeout budget is shorter than real work |
| upstream logs are missing | proxy routing, connection reuse, or earlier hop problem |

## Timeout budgets should be layered

Timeouts are easier to reason about when inner dependency deadlines are shorter than the outer user-facing deadline. For example:

```text
browser/client budget > edge proxy budget > app handler budget > database/API budget
```

If the outer client times out before the inner dependency does, the system wastes work after the caller has already given up. If every layer has the same 30-second timeout, you may get ambiguous failures where the wrong component reports the symptom.

## How to fix it

### If first byte is slow

- profile the upstream handler;
- inspect DB/cache/API latency;
- add server-side timing logs.

Add timing logs around major dependency calls instead of only logging the total request duration. Total time tells you that the request was slow; phase timing tells you where it was slow.

### If response body stalls

- inspect streaming code;
- check proxy buffering;
- reduce large response payloads or flush intentionally.

For streaming endpoints, make sure the application intentionally emits data within the configured idle/read timeout. If no bytes are sent for longer than the proxy read timeout, a perfectly healthy long-running job can still be cut off.

### If packet loss is involved

- fix retransmissions, interface drops, or bad path;
- compare client and server packet captures.

### If idle timeout mismatch is involved

- align client, proxy, load balancer, and upstream read/idle timeouts;
- do not simply set all values very high.

Increasing read timeouts is acceptable only when the endpoint is intentionally long-running and the caller can usefully wait. If the endpoint is slow because of a stuck dependency, raising the timeout increases saturation and makes recovery harder.

## What not to do

- Do not raise timeouts before separating connect, TLS, first byte, and body phases.
- Do not retry blindly if the server may still be processing the first request.
- Do not ignore upstream work that continues after the client has timed out.
- Do not use a successful ping as proof that application reads are healthy.
- Do not make every timeout value identical across all layers.

## Short checklist

- Prove connect succeeds before debugging read timeout.
- Measure first byte separately from total time.
- Compare client-side wait with upstream logs.
- Check retransmissions during the stalled window.
- Tune read deadlines only after finding the slow phase.
- Make timeout budgets explicit so the right layer fails first.
