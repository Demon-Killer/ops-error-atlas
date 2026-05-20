---
title: 'What causes "i/o timeout" in backend systems'
description: A practical i/o timeout guide for backend services that separates DNS, TCP connect, TLS, read deadlines, storage stalls, dependency latency, and overly aggressive timeout budgets.
slug: io-timeout
publishedAt: 2026-05-02
updatedAt: 2026-05-20
tags:
  - timeout
  - backend
  - networking
related:
  - read-connection-timed-out
  - curl-28-operation-timed-out
  - high-network-latency
  - tcp-retransmissions
---

`i/o timeout` means an input or output operation did not finish before its deadline. In backend systems, that operation might be DNS lookup, TCP connect, TLS handshake, reading a response, writing a request, querying storage, or waiting on a downstream dependency. The phrase is broad; the fix depends on which operation timed out.

## What it means

Many runtimes collapse different lower-level failures into `i/o timeout`. A service log might show the same phrase for:

- DNS resolution delay;
- network connect timeout;
- TLS handshake timeout;
- response read deadline;
- storage stall;
- downstream API delay;
- overloaded dependency.

Your first task is to identify the dependency and phase.

## Common causes

- Slow or failing DNS.
- Packet loss or retransmissions.
- Firewall, proxy, or load balancer stalls.
- Slow upstream application.
- Database, cache, or queue latency.
- Timeout settings lower than real p95 or p99 latency.
- Connection pool exhaustion causing requests to wait before I/O starts.

## Fast triage order

1. Identify the exact dependency in the log.
2. Identify the phase: DNS, connect, TLS, write, read, or storage.
3. Compare timeout timestamps with dependency logs.
4. Measure the dependency from the same host or container.
5. Check connection pools, worker pools, and queueing.
6. Tune timeout budgets only after measuring normal and incident latency.

## Commands to try

### For HTTP dependencies

```bash
curl -s -o /dev/null \
  -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
  https://<dependency-host>
```

### For network path issues

```bash
mtr -rw <dependency-host>
tcpdump -nn -i any host <dependency-ip>
netstat -s | grep -Ei 'retrans|timeout'
```

### For storage pressure

```bash
iostat -xz 1 5
pidstat -d 1 5
```

High disk await or saturated I/O can surface as timeouts in services that depend on local or network storage.

### For connection pool pressure

Check application metrics for:

- pool wait time;
- active connections;
- idle connections;
- queue depth;
- timeout count by dependency.

If pool wait is high, the timeout may happen before the request truly reaches the remote dependency.

## How to separate likely causes

| Signal | Likely direction |
| --- | --- |
| DNS time high | resolver or service discovery |
| connect time high | network path, listener, firewall, accept backlog |
| TLS time high | certificates, SNI, protocol/cipher negotiation |
| first byte high | upstream app or dependency latency |
| storage await high | disk or storage backend pressure |
| pool wait high | local concurrency or pool sizing problem |

## Timeout budgeting

Timeouts should form a budget across the call chain. A common mistake is setting every layer to the same large timeout. That makes failures slow and hard to attribute.

Prefer:

- shorter dependency timeouts inside the application;
- clear per-dependency timeout logs;
- proxy timeouts that are longer than app dependency deadlines;
- client timeouts that match user-facing expectations.

## What not to do

- Do not raise timeouts before identifying the phase.
- Do not assume `i/o timeout` always means network failure.
- Do not test from your laptop if the service runs in a container or private subnet.
- Do not ignore connection pool wait time.

## How to fix it

### If DNS is slow

- fix resolver health;
- reduce bad search-domain behavior;
- check service discovery latency.

### If network connect is slow

- inspect path, firewall, listener, and accept backlog;
- compare from the same host and namespace as the application.

### If reads are slow

- inspect upstream app latency;
- check downstream dependencies of that upstream;
- add server-side timing logs.

### If local pool pressure is the cause

- tune pool size based on measured concurrency;
- reduce slow requests holding connections;
- add backpressure instead of letting all requests wait until timeout.

## Short checklist

- Identify the exact dependency and phase.
- Measure from the same runtime environment as the app.
- Check pool wait and dependency latency.
- Use timeout budgets, not one global large timeout.
- Fix the slow phase before raising deadlines.
