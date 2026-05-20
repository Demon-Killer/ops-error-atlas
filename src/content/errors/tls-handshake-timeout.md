---
title: 'What causes TLS handshake timeout'
description: A practical TLS handshake timeout guide that separates TCP connect delay, packet loss, SNI, certificate exchange, server CPU pressure, mTLS, and proxy TLS termination issues.
slug: tls-handshake-timeout
publishedAt: 2026-05-14
updatedAt: 2026-05-20
tags:
  - TLS
  - timeout
  - HTTPS
related:
  - tls-handshake-failure
  - curl-28-operation-timed-out
  - high-network-latency
  - x509-certificate-signed-by-unknown-authority
---

`TLS handshake timeout` means the secure session did not complete before the configured deadline. TCP may have connected successfully, but TLS negotiation did not finish in time. The cause may be packet loss, server CPU pressure, SNI or certificate exchange issues, mTLS delays, or a proxy terminating TLS on the wrong hop.

## What it means

An HTTPS request usually progresses like this:

```text
DNS -> TCP connect -> TLS handshake -> HTTP request -> response
```

TLS handshake timeout sits between TCP and HTTP. If you debug only HTTP handlers, you may miss the failure entirely.

## Common causes

- High latency or packet loss during handshake.
- Server CPU saturation from too many handshakes.
- TLS configuration with expensive or incompatible negotiation.
- SNI points to the wrong virtual host.
- Server requests a client certificate and the client stalls or fails.
- Load balancer or proxy expects a different TLS/plaintext mode.
- Timeout values are too aggressive for the path.

## Fast triage order

1. Measure TCP connect time separately from TLS time.
2. Test with `openssl s_client` using SNI.
3. Compare successful and failing clients.
4. Check server CPU and connection rate during failures.
5. Inspect packet loss and retransmissions.
6. Verify TLS termination across load balancer, Nginx, and upstream.

## Commands to try

### Break down curl timing

```bash
curl -s -o /dev/null \
  -w 'connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
  https://<host>
```

High `time_appconnect` means TLS negotiation is the slow phase.

### Inspect the TLS handshake

```bash
openssl s_client -connect <host>:443 -servername <host>
```

Always include `-servername` for SNI.

### Test versions if client behavior differs

```bash
openssl s_client -connect <host>:443 -servername <host> -tls1_2
openssl s_client -connect <host>:443 -servername <host> -tls1_3
```

### Check network path

```bash
mtr -rw <host>
tcpdump -nn -i any host <host-ip> and port 443
```

### Check server pressure

```bash
top
vmstat 1 5
ss -tan state established '( sport = :443 )'
```

## How to interpret signals

| Signal | Likely direction |
| --- | --- |
| TCP connect fast, TLS slow | TLS negotiation, CPU, certificate, SNI, mTLS |
| TCP connect slow too | network path, firewall, listener pressure |
| only old clients fail | TLS version or cipher policy |
| only one backend fails | instance-level CPU, config, or certificate issue |
| failures under burst traffic | handshake concurrency or CPU saturation |
| works with direct upstream but not through proxy | TLS termination or proxy config |

## Load balancer and proxy checks

For this path:

```text
client -> load balancer -> Nginx -> upstream
```

Confirm:

- where TLS terminates;
- whether the next hop is HTTP or HTTPS;
- whether SNI is preserved or rewritten;
- whether mTLS is required on any hop;
- whether timeout budgets align across all hops.

## How to fix it

### If network loss causes the timeout

- fix packet loss or routing instability;
- compare affected regions and paths;
- collect packet evidence before changing TLS settings.

### If server CPU is the bottleneck

- reduce handshake rate with connection reuse;
- scale TLS termination;
- inspect expensive cipher or certificate choices;
- check whether traffic spikes bypass keepalive.

### If SNI or certificate selection is wrong

- send the correct SNI;
- fix virtual host certificate mapping;
- retest with `openssl s_client -servername`.

### If proxy TLS mode is wrong

- align `http://` vs `https://` between every hop;
- verify whether TLS should terminate or pass through;
- check load balancer listener and target settings.

## What not to do

- Do not treat handshake timeout as a certificate trust error without evidence.
- Do not test with openssl without SNI and trust the result.
- Do not debug app handlers before proving TLS completes.
- Do not raise handshake timeouts without checking CPU and packet loss.

## Short checklist

- Separate TCP connect time from TLS time.
- Test with SNI using `openssl s_client`.
- Check packet loss and retransmissions.
- Check TLS termination and proxy mode.
- Inspect server CPU and handshake concurrency during failures.
