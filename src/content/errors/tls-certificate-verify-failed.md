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

The word "failed" is too broad to debug directly. You need to separate four questions:

1. Did the server present the certificate for the hostname the client requested?
2. Is the certificate valid at the client's current clock time?
3. Can the client build a full chain to a trusted root?
4. Does the runtime use the trust store you think it uses?

Only after those are answered should you change certificates or trust stores.

## Common causes

- Hostname mismatch.
- Expired or not-yet-valid certificate.
- Missing intermediate certificate.
- Private CA not installed in the client trust store.
- Container image missing CA certificates.
- Runtime uses a different CA bundle than the OS.
- Intercepting proxy or corporate MITM certificate is not trusted.

## Do not skip SNI

Many HTTPS servers host multiple certificates on the same IP address. The client uses SNI, Server Name Indication, to tell the server which hostname it wants during the TLS handshake.

This command is correct:

```bash
openssl s_client -connect <host>:443 -servername <host> -showcerts
```

This command can be misleading:

```bash
openssl s_client -connect <host>:443 -showcerts
```

Without `-servername`, the server may return a default certificate that no real browser or application would receive.

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

Look for:

- the leaf certificate subject and SAN;
- intermediate certificates;
- verification return code;
- whether the chain stops before a trusted root.

### Test with curl

```bash
curl -v https://<host>
curl -vk https://<host>
```

`-k` is useful only to confirm that verification is the failing step. It is not a production fix.

Also test with the exact hostname used by the failing application. Testing the load balancer DNS name is not equivalent to testing the application hostname if certificates are host-specific.

### Inspect certificate fields

```bash
openssl x509 -in cert.pem -noout -subject -issuer -dates
openssl x509 -in cert.pem -noout -text | grep -A2 'Subject Alternative Name'
```

The SAN extension is usually what matters for hostname verification. Modern clients do not rely on the legacy Common Name the way older tooling once did.

### Verify with a specific CA bundle

```bash
openssl verify -CAfile ca-bundle.pem server-cert.pem
```

For a realistic chain verification, include intermediates properly:

```bash
openssl verify -CAfile root-ca.pem -untrusted intermediates.pem leaf.pem
```

### Test from a container

```bash
docker run --rm -it <image> sh
curl -v https://<host>
ls -l /etc/ssl/certs
```

Minimal images often omit CA bundles. The host may trust the certificate while the container does not.

### Check runtime-specific trust

Some runtimes do not use the OS trust store exactly as you expect:

```bash
python -c "import ssl; print(ssl.get_default_verify_paths())"
node -p "process.versions.openssl"
java -XshowSettings:properties -version 2>&1 | grep -i trust
```

This is especially important for Java services, custom containers, corporate roots, and internal PKI.

## How to interpret signals

| Signal | Likely cause |
| --- | --- |
| browser works, container fails | missing CA bundle in container |
| all clients fail | server chain, hostname, or expiry problem |
| only internal services fail | private CA not distributed |
| curl works, app fails | runtime-specific trust store |
| `-k` works but normal curl fails | verification issue, not basic reachability |
| browser works, CLI fails | different trust store or missing intermediate |
| failure appears after renewal | wrong chain, wrong SAN, or clock/validity issue |
| one hostname works on same IP | SNI or virtual-host certificate selection |

## Chain problems vs trust problems

A server-side chain problem means the server does not send enough information for normal clients to build trust. A client-side trust problem means the chain is fine for clients that trust the issuing root, but this client does not trust that root.

Practical rule:

- if public browsers and clean external clients fail, fix the server certificate or chain;
- if only your container, VM, or runtime fails, inspect the client trust store;
- if only internal names fail, check private CA distribution and service mesh or proxy interception;
- if only one hostname fails on the same endpoint, check SAN and SNI.

## Server-side vs client-side fixes

### Server-side fix

Use this when the chain, hostname, or expiry is wrong:

- install full certificate chain;
- include intermediate certificates;
- issue certificate for the correct hostname;
- renew expired certificates.

For public sites, install the full chain provided by the CA, not just the leaf certificate. For internal sites, publish a consistent chain and distribute the root CA through a controlled mechanism.

### Client-side fix

Use this when the certificate is valid but the client lacks trust:

- install the private root CA;
- update container CA bundle;
- configure runtime-specific trust store;
- document CA distribution for all deployment environments.

Install the root CA, or the correct corporate/intermediate CA according to your PKI model. Do not pin a short-lived leaf certificate into every container unless you want future renewals to break deployments.

## Safe temporary workarounds

Sometimes you need to restore a non-production workflow quickly. Acceptable temporary actions:

- use `curl -k` only for one manual diagnostic command;
- point a test client at a known CA bundle with `--cacert`;
- roll back a bad certificate deployment;
- temporarily route traffic to a host with the correct certificate.

Unsafe production actions:

- disabling TLS verification in application code;
- setting global environment flags that skip verification;
- copying a random certificate into a trust store without knowing whether it is a root, intermediate, or leaf;
- ignoring hostname mismatch because encryption still "works."

## What not to do

- Do not permanently disable verification.
- Do not ship `curl -k` behavior into code.
- Do not copy the leaf certificate into a trust store when you should install the root CA.
- Do not assume host trust store applies inside containers or language runtimes.
- Do not inspect a virtual-hosted TLS endpoint without SNI.

## Short checklist

- Inspect the chain with SNI.
- Check SAN hostname and certificate dates.
- Reproduce from the failing runtime.
- Separate server chain defects from client trust-store gaps.
- Fix trust intentionally; do not disable verification.
- Confirm the fix from the exact container, host, or runtime that failed.
