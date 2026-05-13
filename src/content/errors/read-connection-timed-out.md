---
title: 'Why "read: connection timed out" happens'
description: Understand read-side timeouts, how they differ from connect failures, and what to inspect before changing timeout values.
slug: read-connection-timed-out
publishedAt: 2026-05-04
tags:
  - timeout
  - TCP
  - Linux
related:
  - curl-28-operation-timed-out
  - io-timeout
---

`read: connection timed out` usually means the connection was established, but the application did not receive data before the read timeout expired. This points to slow response delivery, packet loss, or downstream stalls rather than a pure connect failure.

## What it means

The client reached the server, but the expected bytes did not arrive within the configured read window. That is different from DNS or TCP connect problems.

## Common causes

- The upstream service is too slow to produce a response.
- Packet loss or retransmissions delay delivery.
- Intermediate proxies or firewalls interfere with idle flows.
- Read timeout values are too short for the actual workload.

## How to diagnose it

Check whether data is delayed or never sent at all.

1. Confirm that the connection setup succeeds.
2. Measure time to first byte if possible.
3. Inspect packet behavior during the wait.
4. Compare the read timeout with real response time.

## Commands to try

```bash
curl -v https://<host>
ss -tanp
tcpdump -nn host <peer-ip>
journalctl -u your-service --since -15m
```

## How to fix it

Only raise the read timeout after you confirm the service is healthy and just slower than expected. If the upstream is blocked or packets are being lost, fix those conditions first.

## FAQ

### Is this the same as connection refused?

No. A refusal happens during connect. A read timeout happens after the connection exists.

### Can idle timeouts from proxies trigger it?

Yes. Some proxies close or stall flows in ways that surface as client-side read timeouts.

## Short checklist

- Confirm connect succeeds
- Measure time to first response data
- Inspect loss, stalls, and proxy idle behavior
