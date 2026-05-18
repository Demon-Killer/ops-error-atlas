---
title: 'How to debug "x509: certificate signed by unknown authority"'
description: A practical x509 unknown authority guide that separates incomplete server chains, missing client trust stores, internal CAs, containers, and runtime-specific TLS behavior.
slug: x509-certificate-signed-by-unknown-authority
publishedAt: 2026-05-14
tags:
  - TLS
  - x509
  - certificates
related:
  - tls-certificate-verify-failed
  - tls-handshake-failure
popular: true
---

`x509: certificate signed by unknown authority` means the client cannot build a trusted certificate path from the server certificate to a certificate authority it accepts. The mistake is assuming this is always a server problem. Sometimes the server sends an incomplete chain. Sometimes the client trust store is missing a private CA. Sometimes the application runtime is not using the trust store you updated.

## What it means

During the TLS handshake, the server presents a certificate chain. The client then tries to verify that chain against its trusted root certificates.

The error means one of these is true:

- the server certificate is self-signed and not trusted by the client;
- the server omitted an intermediate certificate;
- the certificate is signed by a private/internal CA that the client does not trust;
- the client has an outdated or minimal CA bundle;
- the app runtime uses a different trust store than your shell command.

## Fast diagnosis order

Use this order to avoid changing the wrong side:

1. Inspect the certificate chain the server actually sends.
2. Reproduce the failure in the exact runtime that fails.
3. Compare a working client with the failing client.
4. Decide whether the fix belongs on the server chain or the client trust store.
5. Avoid any permanent fix that disables verification.

## Inspect the server certificate chain

Run this from a clean client environment:

```bash
openssl s_client -connect <host>:443 -servername <host> -showcerts
```

Check:

- how many certificates the server sends;
- whether the leaf certificate matches the hostname;
- whether the intermediate certificate is present;
- whether the issuer is public, private, or self-signed.

If the server sends only the leaf certificate when an intermediate is required, fix the server chain first.

## Verify with curl

```bash
curl -v https://<host>
```

Useful differences:

- `curl` fails everywhere: likely server chain or private CA distribution problem.
- `curl` works on host but fails in container: likely container CA bundle problem.
- `curl` works but app fails: likely runtime-specific trust configuration.

## Server-side vs client-side signs

| Signal | Likely cause |
| --- | --- |
| Many independent clients fail | Server chain is incomplete or CA is private |
| Browser works but container fails | Container trust store is missing CA certificates |
| Host works but app fails | Runtime or app-specific trust store |
| Only internal domains fail | Internal CA is not distributed everywhere |
| `openssl s_client` shows missing intermediate | Server did not send the full chain |

## Container checks

Minimal images often lack a full CA bundle. Test inside the real image, not only on your laptop.

```bash
docker run --rm -it <image> sh
curl -v https://<host>
ls -l /etc/ssl/certs
```

On Alpine-based images:

```bash
apk add --no-cache ca-certificates
update-ca-certificates
```

On Debian or Ubuntu-based images:

```bash
apt-get update
apt-get install -y ca-certificates
update-ca-certificates
```

For internal CAs, copy the CA certificate into the image intentionally and rebuild the trust bundle. Do not rely on the host trust store unless the application actually runs on the host.

## Runtime-specific checks

Some runtimes or SDKs may use their own trust configuration or allow overriding the CA file. If command-line `curl` works but the application fails, inspect the application runtime.

Common examples:

- Java may use a JVM truststore such as `cacerts`.
- Node.js can be configured with `NODE_EXTRA_CA_CERTS`.
- Go usually uses the system pool, but static builds and container images still depend on the runtime environment.
- Custom HTTP clients may set their own CA bundle.

The key point is simple: test the trust store used by the failing process, not a different tool.

## Commands to try

### Show the chain from the server

```bash
openssl s_client -connect <host>:443 -servername <host> -showcerts </dev/null
```

### Save and inspect a certificate

```bash
openssl x509 -in cert.pem -noout -subject -issuer -dates
openssl x509 -in cert.pem -noout -text
```

### Verify against a specific CA bundle

```bash
openssl verify -CAfile ca-bundle.pem server-cert.pem
```

### Test from the actual runtime host

```bash
curl -v https://<host>
env | grep -i ca
```

## What not to do

Avoid these as production fixes:

- `curl -k`;
- `--insecure`;
- `InsecureSkipVerify`;
- disabling certificate verification in an SDK;
- copying random certificate files without knowing whether they are leaf, intermediate, or root certificates.

Those shortcuts can help confirm a trust problem, but they remove the security property TLS is supposed to provide.

## How to fix it

### If the server chain is incomplete

- install the full chain on the server;
- include required intermediate certificates;
- retest from a clean environment that did not previously trust the chain.

### If the client lacks the CA

- install the public CA bundle or internal root CA in the failing runtime;
- rebuild containers after adding CA certificates;
- document the CA distribution path for future deployments.

### If the app runtime uses a separate trust store

- configure the runtime trust store explicitly;
- keep runtime trust configuration versioned with the service;
- verify with the same binary, image, and environment used in production.

## Related errors and how they differ

### `certificate verify failed`

A broader verification failure. It may include unknown authority, hostname mismatch, expiry, or invalid chain.

### `TLS handshake failure`

A broader handshake failure. It can be caused by certificates, protocol versions, ciphers, SNI, or client/server policy mismatch.

## Short checklist

- Inspect the exact chain sent by the server.
- Reproduce the failure in the real runtime environment.
- Decide whether the missing trust is server-side or client-side.
- Fix the certificate chain or trust store, not the symptom.
- Never ship a permanent fix that disables verification.
