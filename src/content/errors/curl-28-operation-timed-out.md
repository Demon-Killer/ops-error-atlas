---
title: 'How to diagnose "curl: (28) operation timed out"'
description: A practical curl error 28 guide that breaks timeout failures into DNS, TCP connect, TLS handshake, first byte, response body, and upstream application latency.
slug: curl-28-operation-timed-out
publishedAt: 2026-05-11
updatedAt: 2026-05-19
tags:
  - curl
  - timeout
  - HTTP
related:
  - nginx-upstream-timed-out
  - tls-handshake-failure
  - high-network-latency
  - dns-server-unreachable
popular: true
---

`curl: (28) operation timed out` means the request did not finish before curl's timeout budget expired. The important part is not the number `28`; it is which phase consumed the time: DNS lookup, TCP connect, TLS handshake, waiting for the first byte, or reading the response body.

## What it means

A typical HTTPS request has several phases:

```text
DNS lookup -> TCP connect -> TLS handshake -> request sent -> first byte -> response body
```

Any one of those phases can consume the timeout. Raising the timeout without identifying the slow phase often hides the real problem.

## Common causes

- DNS lookup is slow or unstable.
- TCP packets are dropped or delayed.
- TLS negotiation is slow or failing.
- The upstream service accepts the connection but does not respond.
- A proxy or firewall stalls the request path.
- The timeout value is lower than normal p95 or p99 latency.

## Fast triage order

1. Re-run curl with timing fields.
2. Separate DNS, connect, TLS, first byte, and total time.
3. Test the same URL from a different network or host.
4. Test the upstream directly if a proxy is involved.
5. Compare curl timing with server-side access logs.

## Commands to try

### Get a timing breakdown

```bash
curl -s -o /dev/null \
  -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} starttransfer=%{time_starttransfer} total=%{time_total}\n' \
  https://your-endpoint.example
```

Interpretation:

| Field | What it points to |
| --- | --- |
| `time_namelookup` high | DNS issue |
| `time_connect` high | TCP/network reachability |
| `time_appconnect` high | TLS handshake |
| `time_starttransfer` high | upstream app or proxy delay |
| `time_total` high but first byte normal | slow response body |

### Use verbose mode

```bash
curl -v https://your-endpoint.example
```

This shows DNS resolution, connection target, TLS negotiation, and response headers.

### Set phase-specific timeout limits

```bash
curl --connect-timeout 3 --max-time 10 -v https://your-endpoint.example
```

`--connect-timeout` isolates connection setup. `--max-time` caps the whole request.

### Check DNS

```bash
dig your-endpoint.example
dig @8.8.8.8 your-endpoint.example
```

Compare resolver behavior if DNS time is high.

### Check network path

```bash
mtr -rw your-endpoint.example
tcpdump -nn host <remote-ip>
```

Packet loss and retransmissions can make curl hit timeout even when the service is alive.

## How to fix it

### If DNS is slow

- check resolver health;
- reduce bad search-domain behavior;
- fix internal DNS forwarding;
- cache DNS where appropriate.

### If TCP connect is slow

- inspect firewall, routing, packet loss, and remote listener health;
- compare from multiple networks;
- check whether only one IP address behind DNS is bad.

### If TLS is slow

- inspect certificate chain and SNI;
- compare TLS versions and ciphers;
- test with `openssl s_client`.

### If first byte is slow

- inspect upstream app logs;
- check DB/cache/downstream dependency latency;
- compare with Nginx or load balancer timing fields.

### If response body is slow

- inspect payload size;
- check streaming behavior;
- compare client bandwidth and server write time.

## What not to do

- Do not immediately increase `--max-time`.
- Do not assume every curl timeout is a network issue.
- Do not test only from your laptop if production callers run elsewhere.
- Do not ignore DNS and TLS phases.

## Short checklist

- Use curl timing fields first.
- Identify the slow phase.
- Compare client-side timing with server-side logs.
- Fix DNS, network, TLS, or upstream latency based on evidence.
- Raise timeouts only after proving the workload needs it.
