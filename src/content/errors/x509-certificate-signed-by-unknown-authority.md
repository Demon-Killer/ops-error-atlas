---
title: 'How to debug "x509: certificate signed by unknown authority"'
description: A practical guide to x509 unknown authority errors that separates server chain problems from client trust-store gaps, especially in containers and internal services.
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

`x509: certificate signed by unknown authority` means the client cannot build a trusted path from the server certificate to a certificate authority it accepts. The mistake many people make is assuming this is always a server problem. Sometimes it is. Sometimes the server sends an incomplete chain. But sometimes the client trust store is missing the right CA, especially inside containers, internal networks, or custom runtimes.

## What it means

The client received a certificate chain it does not trust enough to continue. That usually means one of these:

- the server sent an incomplete chain
- the CA is not trusted by the client
- the certificate is self-signed or signed by a private CA
- the client runtime is using a different trust store than you expected

## Common causes

- The server omits an intermediate certificate.
- The service uses an internal CA that is not installed on the client.
- A container image has an outdated or minimal CA bundle.
- A programming runtime uses its own trust store instead of the OS bundle.
- A developer “fixed” the cert path on one host but not in the actual deployment environment.

## Why this error is easy to misdiagnose

Because people often test from one place and deploy from another:

- browser works, container fails
- host works, application runtime fails
- one language SDK works, another fails

That usually means the trust decision differs by environment, not that the certificate is randomly broken.

## Fast diagnosis order

1. Inspect the certificate chain the server actually sends.
2. Identify which client environment fails.
3. Compare that failing environment’s trust store with a working one.
4. Only then decide whether the fix belongs on the server or the client.

## Commands to try

### Inspect the full chain the server presents

```bash
openssl s_client -connect <host>:443 -servername <host> -showcerts
```

This tells you what the server really sends on the wire, not what you think it should send.

### Test with curl

```bash
curl -v https://<host>
```

If curl fails on one machine but succeeds on another, compare trust stores before changing the certificate.

### Inspect a local CA bundle

```bash
ls -l /etc/ssl/certs
grep -R "<your CA name>" /etc/ssl/certs
```

### In containers

```bash
docker run --rm -it <image> sh
apk info ca-certificates || dpkg -l | grep ca-certificates
curl -v https://<host>
```

The point is to test **inside the real runtime**, not just on your laptop.

## How to tell whether it is a server-side or client-side problem

### Strong signs it is a server-side chain problem

- multiple standard clients fail
- `openssl s_client -showcerts` shows a missing intermediate
- browsers warn too, not just one CLI tool

### Strong signs it is a client-side trust problem

- one environment works and another fails
- internal CA is expected but not installed everywhere
- minimal container images fail while full host OS succeeds

## High-value environment-specific checks

### Linux host vs container

A common trap is:

- host trust store updated
- container trust store not updated

If the app runs in a container, the host result is secondary. The container result is what matters.

### Language runtime trust stores

Some runtimes or SDKs do not rely entirely on the OS certificate bundle. If curl works but the application still fails, inspect the runtime-specific trust behavior.

### Internal PKI

For internal services, “unknown authority” may be the correct behavior until your internal CA is distributed properly. The fix is not to disable verification. The fix is to distribute trust intentionally.

## What not to do

Avoid these shortcuts:

- `curl -k`
- disabling certificate verification in code
- copying random cert files without understanding chain order

Those can be useful for temporary diagnosis, but not as production fixes.

## How to fix it

### If the server sends an incomplete chain

- install the intermediate certificate correctly
- verify the chain from a clean client

### If the client is missing the right CA

- install the CA in the actual runtime environment
- update container images or trust bundles consistently

### If the runtime uses a separate trust mechanism

- configure that runtime explicitly
- document the expected trust source for future deploys

## FAQ

### Why does the browser work but the container fails?

Because the browser and the container may trust different CA bundles or receive different environment configuration.

### Is this the same as `certificate verify failed`?

It is a closely related family of failures. `unknown authority` is more specific: the trust anchor could not be established.

### Should I add my internal CA to every environment?

If that CA is legitimately required, yes. Do it intentionally, consistently, and document it.

## Short checklist

- Inspect the exact chain sent by the server
- Reproduce the failure in the real runtime, not only on your laptop
- Decide whether the missing trust is on the server or the client
- Never ship a permanent fix that disables verification
