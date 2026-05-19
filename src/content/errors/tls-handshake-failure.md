---
title: 'What causes TLS handshake failure'
description: A practical TLS handshake failure guide that separates certificate chain problems, SNI mismatch, protocol and cipher mismatch, mTLS failures, and proxy TLS termination mistakes.
slug: tls-handshake-failure
publishedAt: 2026-05-09
updatedAt: 2026-05-19
tags:
  - TLS
  - certificates
  - HTTPS
related:
  - x509-certificate-signed-by-unknown-authority
  - tls-certificate-verify-failed
  - tls-handshake-timeout
  - curl-28-operation-timed-out
---

`TLS handshake failure` means the client and server could not finish negotiating a secure session. The TCP connection may be fine, but TLS fails before normal HTTP data moves. The cause may be a certificate problem, SNI mismatch, protocol version mismatch, cipher mismatch, client certificate requirement, or a proxy using the wrong TLS termination mode.

## What it means

A simplified HTTPS connection looks like this:

```text
TCP connect -> TLS ClientHello -> certificate exchange -> key negotiation -> HTTP request
```

TLS handshake failure happens before the HTTP request is usable. That means HTTP logs may be empty or misleading because the application layer never really started.

## Common causes

- The server certificate chain is invalid or incomplete.
- The client does not trust the issuing CA.
- SNI points to the wrong virtual host.
- Client and server do not share a supported TLS version.
- Cipher suites do not overlap.
- The server requires a client certificate and the client does not provide one.
- A load balancer terminates TLS on the wrong hop.
- The client sends HTTPS to a plain HTTP port, or HTTP to a TLS port.

## Fast triage order

1. Confirm the TCP connection succeeds.
2. Inspect the server certificate with SNI enabled.
3. Check certificate trust and hostname match.
4. Test TLS versions and ciphers if only some clients fail.
5. Check whether mTLS is required.
6. Verify TLS termination points across load balancer, Nginx, and upstream.

## Commands to try

### Inspect the handshake

```bash
openssl s_client -connect your-host:443 -servername your-host
```

Always include `-servername` for SNI. Without it, you may test the wrong certificate.

### Show the full certificate chain

```bash
openssl s_client -connect your-host:443 -servername your-host -showcerts
```

### Test with curl

```bash
curl -v https://your-host
curl -vk https://your-host
```

`-k` can confirm that verification is the problem, but it is not a production fix.

### Test protocol versions

```bash
openssl s_client -connect your-host:443 -servername your-host -tls1_2
openssl s_client -connect your-host:443 -servername your-host -tls1_3
```

Use this when old clients fail but modern clients succeed, or the reverse.

### Capture TLS handshake packets

```bash
tcpdump -nn -i any port 443
```

This will not decrypt traffic, but it can show resets, timeouts, and whether the handshake starts at all.

## How to separate major cases

| Signal | Likely cause |
| --- | --- |
| Browser works but container fails | client trust store issue |
| Fails only without SNI | virtual host certificate selection |
| Old client fails, new client works | TLS version or cipher mismatch |
| Server asks for client cert | mTLS configuration |
| HTTPS request receives plain HTTP | wrong port or TLS termination mistake |
| `x509 unknown authority` | CA trust chain failure |

## Load balancer and proxy checks

TLS failures are often caused by confusion over where HTTPS ends:

```text
client -> load balancer -> Nginx -> upstream
```

Check each hop:

- Does the client speak HTTPS to the load balancer?
- Does the load balancer re-encrypt to Nginx, or send HTTP?
- Does Nginx proxy to upstream with `http://` or `https://`?
- Is upstream expecting TLS or plaintext?

Wrong assumptions here often produce handshake failures or protocol mismatch errors.

## How to fix it

### If the certificate chain is wrong

- install the full chain;
- include intermediate certificates;
- verify with a clean client.

### If SNI is wrong

- configure the correct server name;
- ensure clients send the expected hostname;
- check virtual host ordering on the server.

### If protocols or ciphers do not overlap

- identify the failing client family;
- align TLS versions and cipher policy;
- avoid enabling obsolete protocols unless there is a deliberate compatibility requirement.

### If mTLS is required

- provide the client certificate and key;
- install the correct client CA on the server;
- check certificate purpose and validity.

## What not to do

- Do not disable certificate verification as a permanent fix.
- Do not test without SNI and assume the result is valid.
- Do not debug HTTP handlers before proving the TLS handshake completes.
- Do not change TLS policy blindly for all clients.

## Short checklist

- Confirm TCP connect works.
- Test with `openssl s_client -servername`.
- Inspect certificate chain and hostname.
- Compare failing and working client TLS versions.
- Verify TLS termination on every proxy hop.
