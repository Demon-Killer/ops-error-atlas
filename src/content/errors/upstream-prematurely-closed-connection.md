---
title: 'Why "upstream prematurely closed connection" happens in Nginx'
description: Learn what upstream prematurely closed connection means in Nginx and how to tell whether the app, proxy, or transport layer ended the response first.
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
popular: true
---

`upstream prematurely closed connection` in Nginx means the upstream side closed the connection before Nginx received the full response it expected. In practice, the upstream may have crashed, timed out internally, sent an invalid response, or reset the stream under pressure. The hard part is not understanding the sentence. The hard part is proving **who closed first and why**.

## What it means

Nginx opened or reused a connection to the upstream service, started reading the response, and then saw the stream end too early. That early end may appear as a clean close (`FIN`) or an abrupt reset (`RST`) depending on the failure mode.

This error often turns into:

- `502 Bad Gateway`
- partial responses
- intermittent client failures

## Common causes

- The upstream application crashed or restarted mid-request.
- The upstream hit its own timeout and aborted the response.
- The upstream process returned malformed headers or incomplete body data.
- A proxy or load balancer between Nginx and the app closed the connection.
- Keep-alive reuse exposed an app that does not handle persistent connections cleanly.

## First question: who closed first?

This error is much easier to reason about when you answer that question first.

There are usually three broad cases:

### Case 1: The app closed first

Most likely when:

- the app crashes
- the app times out internally
- the app aborts the request after a downstream failure

### Case 2: An intermediate proxy closed first

Most likely when:

- there is a load balancer between Nginx and the app
- keepalive and idle timeouts do not match
- one hop in the middle has a shorter timeout than the rest

### Case 3: Nginx reused a connection the upstream no longer considered healthy

Most likely when:

- keepalive behavior is inconsistent
- one instance closes idle connections aggressively
- only reused upstream connections fail, while new ones succeed

## How to diagnose it

### 1. Start with Nginx error log lines

```bash
tail -100 /var/log/nginx/error.log
journalctl -u nginx --since -15m
```

Look for:

- the full error line
- upstream host and port
- request path
- whether the failure happens before headers or mid-body

### 2. Compare with upstream app logs

At the same timestamp, ask:

- did the app receive the request?
- did it finish normally?
- did it log a crash, panic, timeout, or broken downstream call?

If the app never saw the request, the failure may be earlier in the path. If it saw the request but died before responding, the app is a stronger suspect.

### 3. Test direct upstream behavior

```bash
curl -v http://upstream-service:port/path
curl -H 'Connection: close' -v http://upstream-service:port/path
```

Comparing normal and `Connection: close` requests can help expose keepalive-specific issues.

### 4. Inspect connection behavior

```bash
ss -tanp
tcpdump -nn host <upstream-ip>
```

What to look for in packet captures:

- `FIN` from upstream: more graceful close
- `RST` from upstream: more abrupt failure
- repeated closes only on reused keepalive connections

### 5. Check keepalive and timeout alignment

```bash
nginx -T
```

Pay attention to:

- upstream keepalive settings
- idle timeout settings on every hop
- app server keepalive behavior

## Common high-value checks

### Check whether only one upstream node fails

If only one instance closes early, compare that node’s:

- CPU usage
- memory pressure
- restart count
- app version
- timeout settings

### Check whether large responses fail more often

If yes, suspect:

- upstream body streaming issues
- proxy buffering behavior
- client or proxy timeouts
- app-side aborts during slow writes

### Check whether failures cluster around deploys

If yes, suspect:

- rolling restart timing
- connection draining not configured correctly
- old and new app versions disagreeing on protocol behavior

## What not to assume

- Do not assume Nginx is the root cause just because it logged the error.
- Do not assume every early close is a network failure.
- Do not assume every `502` is caused by invalid headers. Early closes are common too.

## How to fix it

### If the app is crashing or aborting

- fix the exception or panic path
- inspect downstream timeouts
- verify graceful shutdown during deploys

### If keepalive reuse is the trigger

- align app and Nginx keepalive behavior
- test disabling keepalive temporarily to confirm the theory

### If an intermediate proxy closes idle streams

- align timeout values across all hops
- verify connection draining and idle timeout policy

### If malformed or partial responses are the trigger

- inspect header generation
- inspect streaming or chunked response paths
- compare healthy and failing payloads

## FAQ

### Is this the same as `connection reset by peer`?

Not exactly. They are related. `connection reset by peer` is a transport-level symptom. `upstream prematurely closed connection` is Nginx’s higher-level interpretation of an unexpectedly early upstream close.

### Why does it happen only under load?

Because load exposes concurrency limits, timeout races, keepalive reuse issues, and app shutdown edge cases that may never appear in single-request testing.

### Should I restart Nginx first?

No. Restarting Nginx may clear symptoms temporarily but hides whether the upstream, transport path, or keepalive policy is the real issue.

## Short checklist

- Check whether the app logged the request and how it ended
- Compare reused and fresh upstream connections
- Capture packets if you need to prove who closed first
- Check one-node-only failures before touching global timeout settings
