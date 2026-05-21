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

`curl` is useful because it exposes a client-side timeline. That timeline is not the whole truth, but it tells you what to compare against DNS metrics, Nginx timing, load balancer logs, application logs, and packet captures.

## Common causes

- DNS lookup is slow or unstable.
- TCP packets are dropped or delayed.
- TLS negotiation is slow or failing.
- The upstream service accepts the connection but does not respond.
- A proxy or firewall stalls the request path.
- The timeout value is lower than normal p95 or p99 latency.

## Know which timeout you set

`curl --connect-timeout` and `curl --max-time` are not interchangeable.

| Option | Scope | Typical use |
| --- | --- | --- |
| `--connect-timeout` | connection setup path | prove DNS, TCP, or TLS setup is slow |
| `--max-time` | entire operation | cap the full request |
| `--speed-time` and `--speed-limit` | transfer progress | detect stalled response bodies |

If only `--max-time` is configured, the same error code can represent a DNS stall, connect stall, slow TLS handshake, slow upstream handler, or slow response body.

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

If `time_namelookup` is already high, do not start with Nginx. If `time_starttransfer` is high but connect and TLS are fast, focus on upstream processing, proxy queueing, or server-side dependencies.

### Repeat and compare

```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null \
    -w "$i ip=%{remote_ip} dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n" \
    https://your-endpoint.example
done
```

This catches two common production cases:

- one backend IP behind DNS is bad;
- the endpoint is only slow under intermittent load.

### Use verbose mode

```bash
curl -v https://your-endpoint.example
```

This shows DNS resolution, connection target, TLS negotiation, and response headers.

If the endpoint uses virtual hosting, preserve the real hostname. Testing only the IP address can change SNI, Host routing, and certificate selection.

### Set phase-specific timeout limits

```bash
curl --connect-timeout 3 --max-time 10 -v https://your-endpoint.example
```

`--connect-timeout` isolates connection setup. `--max-time` caps the whole request.

For slow body transfers:

```bash
curl --speed-limit 1024 --speed-time 10 -v https://your-endpoint.example
```

This fails when transfer speed stays below the threshold for the configured time, which is different from a slow first byte.

### Check DNS

```bash
dig your-endpoint.example
dig @8.8.8.8 your-endpoint.example
```

Compare resolver behavior if DNS time is high.

Also test each resolved address directly while preserving the hostname:

```bash
curl -v --resolve your-endpoint.example:443:<ip-address> https://your-endpoint.example/
```

This is one of the fastest ways to find a single bad load-balanced target.

### Check network path

```bash
mtr -rw your-endpoint.example
tcpdump -nn host <remote-ip>
```

Packet loss and retransmissions can make curl hit timeout even when the service is alive.

For connect-phase timeouts, check SYN retransmissions. For read-phase timeouts, check whether response packets stop, retransmit, or arrive after the timeout.

## Compare with server-side timing

Client timing becomes much more useful when paired with server logs:

| Curl timing | Server signal to compare |
| --- | --- |
| high DNS | resolver logs or DNS metrics |
| high connect | listener health, firewall, SYN backlog, packet loss |
| high TLS | TLS termination CPU, certificate chain, handshake errors |
| high first byte | Nginx upstream time, app handler latency |
| high total only | response body size, streaming, slow client path |

If curl times out but the server has no request log, the request likely failed before the application received it. If the server logs a long handler time, the timeout is probably a symptom of upstream latency.

## How to fix it

### If DNS is slow

- check resolver health;
- reduce bad search-domain behavior;
- fix internal DNS forwarding;
- cache DNS where appropriate.

Be careful with search domains. Short names may trigger several DNS attempts before the final query. Use fully qualified names for critical service calls when appropriate.

### If TCP connect is slow

- inspect firewall, routing, packet loss, and remote listener health;
- compare from multiple networks;
- check whether only one IP address behind DNS is bad.

If one IP is bad behind a DNS record, remove it from rotation or fix that target. Increasing curl timeouts only spreads user traffic across the bad target for longer.

### If TLS is slow

- inspect certificate chain and SNI;
- compare TLS versions and ciphers;
- test with `openssl s_client`.

### If first byte is slow

- inspect upstream app logs;
- check DB/cache/downstream dependency latency;
- compare with Nginx or load balancer timing fields.

First-byte delay is often where application work hides. Add server-side timing around dependencies instead of treating curl's total time as the only metric.

### If response body is slow

- inspect payload size;
- check streaming behavior;
- compare client bandwidth and server write time.

For large downloads or streaming responses, consider pagination, compression, resumable transfers, and explicit progress behavior rather than simply increasing `--max-time`.

## What not to do

- Do not immediately increase `--max-time`.
- Do not assume every curl timeout is a network issue.
- Do not test only from your laptop if production callers run elsewhere.
- Do not ignore DNS and TLS phases.
- Do not test an IP address without preserving the hostname when SNI or virtual hosts are involved.
- Do not retry unsafe HTTP methods without idempotency controls.

## Short checklist

- Use curl timing fields first.
- Identify the slow phase.
- Compare client-side timing with server-side logs.
- Fix DNS, network, TLS, or upstream latency based on evidence.
- Raise timeouts only after proving the workload needs it.
- Repeat tests and pin individual resolved IPs when load balancing is involved.
