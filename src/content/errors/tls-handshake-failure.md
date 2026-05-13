---
title: 'What causes TLS handshake failure'
description: Break down TLS handshake failure into certificate, protocol, and cipher mismatches, then verify each assumption with command-line tools.
slug: tls-handshake-failure
publishedAt: 2026-05-09
tags:
  - TLS
  - certificates
  - HTTPS
related:
  - curl-28-operation-timed-out
  - connection-reset-by-peer
---

`TLS handshake failure` means the client and server could not complete cryptographic negotiation before any application data moved. The failure is often caused by certificate problems, protocol mismatches, SNI issues, or unsupported cipher suites.

## What it means

The TCP connection may be fine, but the secure session could not be established. You need to inspect the handshake itself rather than the application payload.

## Common causes

- The certificate chain is invalid or incomplete
- The client and server do not share protocol versions
- Cipher suites do not overlap
- SNI points to the wrong virtual host

## How to diagnose it

Use TLS-specific tools before changing load balancer settings blindly.

1. Verify the certificate chain.
2. Confirm which protocol versions the server accepts.
3. Check whether SNI is required.
4. Compare successful and failing clients.

## Commands to try

```bash
openssl s_client -connect your-host:443 -servername your-host
curl -vk https://your-host
tcpdump -nn port 443
```

## How to fix it

Install a complete certificate chain, align protocol and cipher configuration, and confirm that SNI and virtual host mappings are correct. If only one client family fails, inspect its supported TLS versions and cipher preferences.

## FAQ

### Can a valid certificate still fail the handshake?

Yes. A valid certificate is only one part of the handshake. Version and cipher mismatches still break negotiation.

### Why does one client fail while another works?

Different clients support different TLS versions, ciphers, SNI behavior, and trust stores.

## Short checklist

- Verify the chain with openssl
- Check protocol and cipher overlap
- Confirm SNI and host mapping
