---
title: 'Why "upstream prematurely closed connection" happens in Nginx'
description: A practical guide to Nginx upstream prematurely closed connection errors, focused on proving whether the app, proxy, keepalive reuse, or transport layer closed first.
slug: upstream-prematurely-closed-connection
publishedAt: 2026-05-14
tags:
  - Nginx
  - reverse-proxy
  - sockets
related:
  - nginx-502-bad-gateway
  - connection-reset-by-peer
  - broken-pipe
  - nginx-504-gateway-timeout
popular: true
---

`upstream prematurely closed connection` in Nginx means the upstream side closed the connection before Nginx received the full response it expected. The useful question is not just "what does this mean?" The useful question is: **who closed first, at what phase, and under what load pattern?**

## What it means

Nginx connected to an upstream service, sent or started sending a request, and then the upstream connection ended earlier than expected. Depending on the exact failure, the error may appear while Nginx is:

- connecting to upstream;
- sending the request to upstream;
- reading response headers;
- reading the response body.

The Nginx error log phrase often includes that phase. Do not ignore it.

## Why it often becomes a 502

This error commonly produces `502 Bad Gateway` because Nginx cannot return a valid upstream response to the client. The upstream may have:

- crashed;
- restarted during deploy;
- closed an idle keepalive connection;
- timed out internally;
- returned malformed headers;
- aborted while streaming a response body.

## First question: who closed first?

Think in three layers:

```text
Nginx -> load balancer or service mesh -> upstream app -> downstream dependency
```

The component that logs the error is not always the component that caused it.

| Observation | Likely direction |
| --- | --- |
| App logs show panic, crash, or restart | Upstream app closed first |
| Only reused connections fail | Keepalive or idle timeout mismatch |
| Only one upstream instance fails | Bad node, bad deploy, or host pressure |
| Large responses fail more often | Streaming, buffering, or slow client path |
| Failure appears during deploys | Missing graceful shutdown or draining |
| Packet capture shows upstream `RST` | Upstream or middle proxy reset the connection |

## How to diagnose it

### 1. Start from the exact Nginx error

```bash
tail -200 /var/log/nginx/error.log
journalctl -u nginx --since -30m
```

Preserve the full line. These details matter:

- upstream address;
- request path;
- whether the error happened while reading headers or body;
- timestamp;
- client request method;
- response size if available in access logs.

### 2. Match the same request in app logs

At the same timestamp, check:

- Did the app receive the request?
- Did the handler finish?
- Was there a panic, exception, worker restart, OOM kill, or deploy?
- Did the app call a slow dependency and abort?

If the app never saw the request, inspect routing, service discovery, load balancer, and connection reuse. If the app saw it and died before response completion, the upstream app is the primary suspect.

### 3. Compare fresh and reused connections

```bash
curl -v http://upstream-service:port/path
curl -H 'Connection: close' -v http://upstream-service:port/path
```

If forcing `Connection: close` reduces the failure rate, suspect keepalive reuse or idle timeout mismatch.

### 4. Inspect Nginx upstream and keepalive settings

```bash
nginx -T | grep -E 'upstream|keepalive|proxy_http_version|proxy_set_header|timeout'
```

Check whether Nginx, the upstream app server, and any middle proxy agree on:

- idle timeout;
- keepalive support;
- HTTP version;
- connection draining during deploys.

### 5. Use packet capture when logs disagree

```bash
tcpdump -nn -i any host <upstream-ip> and port <upstream-port>
ss -tanp | grep '<upstream-port>'
```

In a capture:

- `FIN` from upstream usually means a graceful close;
- `RST` from upstream means an abrupt reset;
- repeated failures after idle periods point toward keepalive mismatch;
- resets during deploy windows point toward missing draining or forced restarts.

## High-value checks

### Check whether one node is responsible

If only one upstream address appears in error logs, compare that instance against healthy ones:

- CPU and memory;
- restart count;
- app version;
- file descriptor usage;
- dependency latency;
- kernel network counters.

### Check whether the failure is response-size dependent

If small responses succeed but large responses fail, inspect:

- streaming code paths;
- proxy buffering;
- chunked responses;
- slow downstream clients;
- app-side write timeouts.

### Check deploy and restart timing

If errors cluster around deploys, inspect:

- graceful shutdown;
- connection draining;
- load balancer deregistration delay;
- app worker termination policy.

This is a common source of intermittent upstream close errors.

## What not to assume

- Do not assume Nginx is broken because it logged the error.
- Do not assume every early close is a network problem.
- Do not fix it by blindly raising proxy timeouts.
- Do not ignore deploy windows and keepalive behavior.

## How to fix it

### If the app crashes or aborts

- fix the exception path;
- inspect OOM kills and worker restarts;
- make downstream dependency timeouts explicit;
- ensure partial responses are handled safely.

### If keepalive reuse is the trigger

- align idle timeouts across Nginx, load balancer, and app server;
- test disabling upstream keepalive temporarily to confirm the theory;
- ensure the app server handles persistent connections correctly.

### If deploys trigger the error

- add graceful shutdown;
- stop accepting new requests before terminating workers;
- drain load balancer targets before killing old processes.

### If malformed responses are the trigger

- inspect response headers;
- check chunked transfer encoding;
- compare failing and successful responses with `curl -v`.

## Related errors and how they differ

### `connection reset by peer`

A transport-level symptom. Nginx may report it when the peer sends an abrupt reset.

### `broken pipe`

Usually means a process tried to write to a connection the other side already closed.

### `502 Bad Gateway`

Often the client-facing status produced after Nginx fails to get a valid upstream response.

## Short checklist

- Keep the full Nginx error line, including the phase.
- Match the same request in upstream app logs.
- Check whether failures cluster by node, deploy, response size, or keepalive reuse.
- Use packet capture only when logs cannot prove who closed first.
- Fix app shutdown, keepalive alignment, or malformed responses before touching global timeouts.
