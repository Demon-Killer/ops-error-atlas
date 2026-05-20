---
title: 'How to fix "certificate verify failed"'
description: A practical certificate verify failed guide that separates hostname mismatch, expired certificates, incomplete chains, missing trust stores, containers, and runtime-specific CA behavior.
slug: tls-certificate-verify-failed
publishedAt: 2026-05-14
updatedAt: 2026-05-20
tags:
  - TLS
  - certificates
  - HTTPS
related:
  - x509-certificate-signed-by-unknown-authority
  - tls-handshake-failure
  - tls-handshake-timeout
  - curl-28-operation-timed-out
---

`certificate verify failed` means the client rejected the certificate during TLS verification. The TCP connection may work and the TLS handshake may start, but the client refuses to trust the certificate for the requested hostname, validity period, issuing authority, or chain.

## What it means

Certificate verification usually checks:

- hostname matches Subject Alternative Name;
- certificate is not expired or not-yet-valid;
- certificate chain leads to a trusted CA;
- intermediate certificates are present;
- certificate purpose and key usage are acceptable;
- local trust store contains the required CA.

The failing side is often the client environment, not the server alone.

## Common causes

- Hostname mismatch.
- Expired or not-yet-valid certificate.
- Missing intermediate certificate.
- Private CA not installed in the client trust store.
- Container image missing CA certificates.
- Runtime uses a different CA bundle than the OS.
- Intercepting proxy or corporate MITM certificate is not trusted.

## Fast triage order

1. Inspect the exact certificate chain the server sends.
2. Check hostname and SAN values.
3. Check certificate dates.
4. Reproduce from the failing runtime, container, or host.
5. Compare a working client with the failing client.
6. Decide whether to fix the server chain or client trust store.

## Commands to try

### Inspect server chain

```bash
openssl s_client -connect <host>:443 -servername <host> -showcerts
```

### Test with curl

```bash
curl -v https://<host>
curl -vk https://<host>
```

`-k` is useful only to confirm that verification is the failing step. It is not a production fix.

### Inspect certificate fields

```bash
openssl x509 -in cert.pem -noout -subject -issuer -dates
openssl x509 -in cert.pem -noout -text | grep -A2 'Subject Alternative Name'
```

### Verify with a specific CA bundle

```bash
openssl verify -CAfile ca-bundle.pem server-cert.pem
```

### Test from a container

```bash
docker run --rm -it <image> sh
curl -v https://<host>
ls -l /etc/ssl/certs
```

## How to interpret signals

| Signal | Likely cause |
| --- | --- |
| browser works, container fails | missing CA bundle in container |
| all clients fail | server chain, hostname, or expiry problem |
| only internal services fail | private CA not distributed |
| curl works, app fails | runtime-specific trust store |
| `-k` works but normal curl fails | verification issue, not basic reachability |

## Server-side vs client-side fixes

### Server-side fix

Use this when the chain, hostname, or expiry is wrong:

- install full certificate chain;
- include intermediate certificates;
- issue certificate for the correct hostname;
- renew expired certificates.

### Client-side fix

Use this when the certificate is valid but the client lacks trust:

- install the private root CA;
- update container CA bundle;
- configure runtime-specific trust store;
- document CA distribution for all deployment environments.

## What not to do

- Do not permanently disable verification.
- Do not ship `curl -k` behavior into code.
- Do not copy the leaf certificate into a trust store when you should install the root CA.
- Do not assume host trust store applies inside containers or language runtimes.

## Short checklist

- Inspect the chain with SNI.
- Check SAN hostname and certificate dates.
- Reproduce from the failing runtime.
- Separate server chain defects from client trust-store gaps.
- Fix trust intentionally; do not disable verification.
