---
title: 'How to debug TLS certificate expired errors'
description: A practical TLS certificate expired guide that separates server certificate expiry, intermediate chain expiry, wrong SNI, stale load balancer certificates, client clock drift, and cached trust issues.
slug: tls-certificate-expired
publishedAt: 2026-06-17
updatedAt: 2026-06-17
tags:
  - TLS
  - certificates
  - OpenSSL
related:
  - tls-certificate-verify-failed
  - x509-certificate-signed-by-unknown-authority
  - tls-handshake-failure
  - ssl-wrong-version-number
---

`certificate has expired` means a TLS client rejected a certificate because its validity period does not include the client's current time. The expired certificate may be the leaf server certificate, an intermediate certificate, or a different certificate served because SNI or load balancer configuration selected the wrong identity.

The useful question is:

```text
Which certificate in the chain expired, and which listener served it to this client?
```

Do not renew a random certificate before proving what the client actually received.

## Capture the served chain

Use the same hostname and port as the failing client:

```bash
openssl s_client -connect example.com:443 -servername example.com -showcerts </dev/null
```

Then inspect dates:

```bash
echo | openssl s_client -connect example.com:443 -servername example.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

Also test with curl:

```bash
curl -v https://example.com/
```

Preserve:

- hostname;
- resolved IP;
- port;
- SNI value;
- certificate subject;
- issuer;
- `notBefore` and `notAfter`;
- verification error.

## Leaf vs intermediate expiry

Common cases:

| Expired item | Signal |
| --- | --- |
| leaf certificate | subject matches the site; `notAfter` is in the past |
| intermediate certificate | leaf may look valid, but chain verification fails |
| wrong certificate | subject/SAN does not match the requested hostname |
| stale load balancer cert | direct backend differs from public listener |
| client clock wrong | certificate is valid from external checks but one client rejects it |

If only one client fails, check the client clock before assuming the server certificate is wrong.

## Check SNI and resolved targets

SNI decides which certificate a TLS server may present.

Test each resolved IP while preserving SNI:

```bash
getent hosts example.com
openssl s_client -connect <ip>:443 -servername example.com -showcerts </dev/null
curl -v --resolve example.com:443:<ip> https://example.com/
```

Strong signals:

- one IP serves an old certificate;
- default virtual host serves an expired certificate when SNI is missing;
- direct IP test differs from hostname test;
- CDN or load balancer edge nodes are inconsistent.

Fix path:

- update the certificate on every serving endpoint;
- verify SNI configuration;
- remove stale targets;
- purge or rotate edge/load balancer certificates where applicable.

## Check client time

Certificate validation depends on client time.

On Linux:

```bash
date -u
timedatectl status
```

Strong signals:

- only one host, container, VM, or embedded device fails;
- the client time is far in the past or future;
- NTP is disabled or blocked;
- logs have impossible timestamps.

Fix path:

- restore time synchronization;
- verify UTC time;
- re-run the same TLS command after clock correction.

Do not disable certificate verification because one machine's clock is wrong.

## Load balancer and proxy branch

TLS may terminate at several places:

```text
client -> CDN -> load balancer -> Nginx -> app
```

Each TLS termination point can have a different certificate.

Check:

- CDN certificate;
- load balancer listener certificate;
- Nginx `ssl_certificate`;
- service mesh gateway certificate;
- backend mTLS certificate, if used;
- renewal automation scope.

Nginx:

```bash
nginx -T | grep -n "ssl_certificate"
```

Kubernetes:

```bash
kubectl get secret -A | grep -i tls
kubectl describe ingress <name>
```

The public certificate and internal mTLS certificate are separate. Renewing one does not renew the other.

## Renewal automation failures

Strong signals:

- the certificate expired near a scheduled renewal window;
- DNS-01 or HTTP-01 validation failed;
- cert-manager, ACME client, or cron job logs show errors;
- renewal succeeded on one node but not another;
- new certificate exists on disk but the service did not reload.

Checks:

```bash
ls -l /etc/letsencrypt/live/<name>/
systemctl list-timers
journalctl -u certbot --since -7d
```

For Kubernetes cert-manager:

```bash
kubectl describe certificate <name>
kubectl describe certificaterequest <name>
kubectl logs -n cert-manager deploy/cert-manager --tail=100
```

Fix path:

- fix the validation failure;
- renew the certificate;
- reload or restart the TLS terminator;
- verify from outside the deployment network.

## What not to do

- Do not run `curl -k` and call the incident solved.
- Do not renew only the certificate file if the load balancer still serves an old certificate.
- Do not test by IP without preserving SNI and assume the result matches users.
- Do not ignore intermediate certificate expiry.
- Do not assume all CDN/load balancer edges update at the same moment.
- Do not skip client clock checks when only one client fails.

## Decision tree

```text
certificate expired
|
+-- which cert expired?
|   +-- leaf -> renew serving cert
|   +-- intermediate -> fix chain bundle
|
+-- does every resolved IP serve same cert?
|   +-- no -> stale target or edge
|
+-- does SNI change served cert?
|   +-- yes -> fix virtual host/SNI config
|
+-- only one client fails?
|   +-- yes -> check client clock and trust store
|
+-- renewed cert exists but users still fail?
    +-- reload TLS terminator or update load balancer/CDN
```

## Minimal incident note

```text
hostname:
port:
client error:
client time:
resolved IPs:
SNI used:
served leaf subject:
served issuer:
notBefore:
notAfter:
expired cert in chain:
TLS termination point:
renewal automation status:
fix:
verification command:
```

The incident is solved when the client receives a complete valid chain from the intended listener and the verification command succeeds without disabling certificate checks.

## References

- [OpenSSL `s_client` documentation](https://docs.openssl.org/master/man1/openssl-s_client/)
- [OpenSSL `x509` documentation](https://docs.openssl.org/master/man1/openssl-x509/)
- [Nginx SSL module documentation](https://nginx.org/en/docs/http/ngx_http_ssl_module.html)
- [cert-manager certificate documentation](https://cert-manager.io/docs/usage/certificate/)
