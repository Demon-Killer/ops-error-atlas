---
title: 'How to fix "certificate verify failed"'
description: Learn why certificate verify failed happens in HTTPS clients and how to separate trust-store issues from hostname and chain problems.
slug: tls-certificate-verify-failed
publishedAt: 2026-05-14
tags:
  - TLS
  - certificates
  - HTTPS
related:
  - tls-handshake-failure
  - curl-28-operation-timed-out
  - x509-certificate-signed-by-unknown-authority
---

`certificate verify failed` means the client could not validate the server certificate against its trust rules. In practice, this usually comes from an incomplete certificate chain, a hostname mismatch, an expired certificate, or a missing CA in the local trust store.

## What it means

The TCP and TLS handshake may start correctly, but the client refuses to trust the certificate that the server presented. This is a trust decision, not only a transport decision.

## Common causes

- The server does not send the full certificate chain.
- The certificate hostname does not match the requested domain.
- The certificate is expired or not yet valid.
- The local trust store does not contain the required CA.

## How to diagnose it

Start from the certificate the client actually sees, not from assumptions about what is installed on the server.

1. Inspect the full chain presented by the server.
2. Check the certificate subject and SAN values.
3. Verify certificate dates.
4. Compare a failing client with a working client to spot trust-store differences.

## Commands to try

```bash
openssl s_client -connect <host>:443 -servername <host> -showcerts
curl -v https://<host>
openssl x509 -in cert.pem -text -noout
```

## How to fix it

Install the complete certificate chain on the server, correct the hostname mismatch, renew the certificate if needed, or update the local trust store if the CA is legitimately missing.

## FAQ

### Is this always a server problem?

No. Some failures come from the client trust store, especially in containers, custom runtimes, or minimal Linux images.

### Should I disable certificate verification to fix it?

No. That only hides the problem and removes a core security check.

## Short checklist

- Inspect the chain actually sent by the server
- Check hostname match and validity dates
- Compare trust stores between working and failing clients
