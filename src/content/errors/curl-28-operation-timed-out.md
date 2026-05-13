---
title: 'How to diagnose "curl: (28) operation timed out"'
description: Understand cURL error 28, separate DNS, connect, TLS, and response delays, and test each layer with the right command.
slug: curl-28-operation-timed-out
publishedAt: 2026-05-11
tags:
  - curl
  - timeout
  - HTTP
related:
  - nginx-upstream-timed-out
  - tls-handshake-failure
popular: true
---

`curl: (28) operation timed out` means the request did not finish before the configured timeout expired. The timeout can happen during DNS lookup, TCP connect, TLS handshake, or while waiting for the response body.

## What it means

The timeout is a symptom, not a root cause. Your first job is to figure out which phase of the request path consumed the time budget.

## Common causes

- Slow DNS resolution
- High network latency or packet loss
- TLS negotiation delays
- Overloaded upstream applications
- Timeout values that are lower than normal response latency

## How to diagnose it

Use verbose output or timing breakdowns before changing timeout values.

1. Check whether DNS resolution is slow.
2. Measure TCP connect time separately from total time.
3. Test TLS by itself.
4. Compare cURL timeouts with real service latency.

## Commands to try

```bash
curl -v https://your-endpoint.example
curl -w 'dns:%{time_namelookup} connect:%{time_connect} tls:%{time_appconnect} total:%{time_total}\n' -o /dev/null -s https://your-endpoint.example
dig your-endpoint.example
mtr -rw your-endpoint.example
```

## How to fix it

Only raise timeout values after you identify the slow phase. If the delay is in DNS, fix DNS. If it is in TLS, inspect certificates and handshake behavior. If it is in the upstream application, measure backend latency and queue depth.

## FAQ

### Should I just increase the timeout?

Only after you know where the delay comes from. Increasing the timeout can hide a real availability problem.

### Can packet loss cause cURL 28?

Yes. Packet loss can slow connect, retransmit data, and stretch total response time enough to hit the timeout.

## Short checklist

- Break the request into phases
- Measure DNS, connect, TLS, and total time
- Fix the slow phase instead of guessing
