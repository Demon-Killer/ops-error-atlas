---
title: 'What causes TLS handshake timeout'
description: Understand TLS handshake timeout failures and learn how to separate TCP, certificate, and server-side slowness.
slug: tls-handshake-timeout
publishedAt: 2026-05-14
tags:
  - TLS
  - timeout
  - HTTPS
related:
  - tls-handshake-failure
  - high-network-latency
---

`TLS handshake timeout` means the secure session did not complete before the configured timeout expired. The delay may come from packet loss, overloaded servers, slow cryptographic setup, or network paths that are too unstable for the handshake to finish in time.

## What it means

The TCP connection may exist, but the transition to a trusted encrypted session took too long. This is different from a pure certificate validation error because time, not just trust, is the main symptom.

## Common causes

- High network latency or packet loss
- Overloaded servers handling too many handshakes
- Slow TLS negotiation because of CPU pressure or bad configuration
- Short timeout settings on the client or proxy

## How to diagnose it

Break the problem into layers: TCP connect, TLS negotiation, then application.

1. Measure TCP connect time separately.
2. Test TLS negotiation with a low-level client.
3. Compare handshake speed between healthy and unhealthy hosts.
4. Check server CPU and handshake concurrency during the failures.

## Commands to try

```bash
curl -vk https://<host>
openssl s_client -connect <host>:443 -servername <host>
mtr -rw <host>
top -H -p <pid>
```

## How to fix it

Reduce packet loss, increase handshake capacity on the server, simplify TLS configuration where appropriate, and align timeout settings with real-world handshake behavior.

## FAQ

### Is this the same as certificate verify failed?

No. A handshake timeout is primarily about time. Certificate verify failures are about trust validation.

### Can CPU saturation cause TLS handshake timeout?

Yes. Handshakes can become slow when the server is overloaded or handling too many concurrent cryptographic operations.

## Short checklist

- Measure TCP connect and TLS handshake separately
- Check server load during failures
- Compare timeout settings with real handshake duration
