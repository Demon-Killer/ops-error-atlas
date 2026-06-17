---
title: 'How to fix "SSL wrong version number"'
description: A practical TLS wrong version number guide that separates HTTP-to-HTTPS mismatches, TLS termination mistakes, proxy upstream schemes, STARTTLS confusion, and port mixups.
slug: ssl-wrong-version-number
publishedAt: 2026-06-17
updatedAt: 2026-06-17
tags:
  - TLS
  - OpenSSL
  - proxy
related:
  - tls-handshake-failure
  - tls-handshake-timeout
  - nginx-502-bad-gateway
  - upstream-prematurely-closed-connection
---

`SSL routines: wrong version number` often appears when a TLS client connects to something that is not speaking TLS on that port. Despite the wording, the cause is not always an old TLS version. A very common cause is protocol mismatch: HTTPS client to HTTP server, HTTPS proxy upstream configured for a plain HTTP backend, or TLS sent to a port that expects a different protocol.

The useful question is:

```text
What protocol is actually spoken on this IP and port before application data begins?
```

Do not start by enabling old TLS versions. First prove whether the peer is speaking TLS at all.

## Common shapes

| Symptom | Likely branch |
| --- | --- |
| `curl: (35) SSL routines::wrong version number` | TLS client reached a non-TLS endpoint or wrong port |
| browser says SSL protocol error | HTTPS request hit HTTP service, proxy, or incorrect listener |
| Nginx upstream SSL error | `proxy_pass https://...` used for plain HTTP upstream, or wrong upstream port |
| works with `http://` but not `https://` | endpoint is plain HTTP |
| works on `443` but not custom port | custom port is not configured for TLS |

This error is a protocol evidence problem before it is a certificate problem.

## First test the port directly

Use `curl` with verbose output:

```bash
curl -v http://example.com:443/
curl -vk https://example.com:443/
```

Then use OpenSSL:

```bash
openssl s_client -connect example.com:443 -servername example.com
```

Interpretation:

| Result | Meaning |
| --- | --- |
| OpenSSL shows certificate chain | TLS exists; debug certificate, SNI, or protocol negotiation |
| OpenSSL shows plain HTTP text | HTTPS client reached HTTP service |
| connection closes immediately | proxy/listener rejecting or wrong protocol |
| HTTP works on same port | port is plain HTTP, not TLS |
| TLS works without SNI but fails with hostname, or reverse | virtual host/SNI mismatch |

If OpenSSL receives bytes that look like `HTTP/1.1 400 Bad Request`, the peer is not treating the connection as TLS.

## Case 1: HTTP service behind HTTPS URL

Strong signals:

- `curl http://host:port` returns a normal HTTP response;
- `curl https://host:port` fails with wrong version number;
- the service listens on a development or internal port;
- docs or environment variables use `https://` by mistake.

Fix path:

- change the URL scheme to `http://` for plain HTTP endpoints;
- terminate TLS at a real TLS listener before forwarding to HTTP;
- document which ports are HTTP and which are HTTPS;
- update health checks to match the actual scheme.

Do not use `-k` as a fix. `-k` disables certificate verification; it does not make a plain HTTP service speak TLS.

## Case 2: Nginx upstream scheme mismatch

In Nginx, this often comes from using the wrong upstream scheme:

```nginx
proxy_pass https://backend;
```

when the backend actually expects plain HTTP.

Checks:

```bash
nginx -T | grep -n "proxy_pass"
curl -v http://<backend-ip>:<port>/
curl -vk https://<backend-ip>:<port>/
openssl s_client -connect <backend-ip>:<port> -servername <host>
```

Fix path:

- use `proxy_pass http://backend` when upstream is plain HTTP;
- use `proxy_pass https://backend` only when upstream really speaks TLS;
- configure SNI with `proxy_ssl_server_name on;` when upstream TLS requires hostname;
- preserve the upstream port and scheme in deployment docs.

The client-facing listener and the upstream listener are separate protocol decisions.

## Case 3: TLS termination happens at the wrong layer

A request path might be:

```text
client -> load balancer TLS -> Nginx HTTP -> app HTTP
```

or:

```text
client -> load balancer TCP passthrough -> Nginx TLS -> app HTTP
```

If one component expects TLS termination but another passes raw bytes, the next hop may see the wrong protocol.

Evidence to collect:

- load balancer listener protocol;
- target group protocol;
- Nginx `listen` directives;
- upstream `proxy_pass` scheme;
- application port protocol;
- whether TLS passthrough or termination is intended.

Fix path:

- draw the protocol chain explicitly;
- make each hop either terminate TLS or pass it through, not both;
- align health checks with the same scheme and port as production traffic.

## Case 4: STARTTLS confusion

Some protocols begin in plain text and upgrade to TLS with a command. Examples include SMTP STARTTLS and some database/client modes. Sending raw TLS immediately to a STARTTLS port can fail differently from HTTPS.

Checks:

```bash
openssl s_client -starttls smtp -connect mail.example.com:587
openssl s_client -connect mail.example.com:465
```

Fix path:

- use the client mode that matches the service port;
- distinguish implicit TLS ports from STARTTLS ports;
- do not test every TLS service with HTTPS assumptions.

## Case 5: Wrong port or stale DNS target

Strong signals:

- only one resolved IP fails;
- DNS points to a different service than expected;
- a load balancer target group has mixed protocols;
- old and new deployments expose different ports.

Checks:

```bash
getent hosts example.com
curl -vk --resolve example.com:443:<ip> https://example.com/
openssl s_client -connect <ip>:443 -servername example.com
```

Fix path:

- remove stale DNS targets;
- separate HTTP and HTTPS target groups;
- verify each backend IP;
- avoid mixing TLS and non-TLS services behind one port.

## What not to do

- Do not enable old TLS versions before proving the peer speaks TLS.
- Do not use `curl -k` as a fix for wrong protocol.
- Do not assume port 443 always means HTTPS in internal networks.
- Do not test an upstream through the public listener and assume the internal hop is the same.
- Do not mix HTTP and HTTPS backends in one upstream pool.

## Decision tree

```text
SSL wrong version number
|
+-- openssl s_client returns certificate?
|   +-- yes -> debug TLS version, ciphers, SNI, cert chain
|
+-- HTTP request works on same host:port?
|   +-- yes -> HTTPS client is hitting plain HTTP
|
+-- Nginx or proxy upstream involved?
|   +-- yes -> check proxy_pass scheme and upstream port
|
+-- load balancer involved?
|   +-- yes -> check listener protocol and target protocol
|
+-- STARTTLS protocol?
    +-- yes -> use protocol-specific STARTTLS test
```

## Minimal incident note

```text
client command:
host and port:
expected protocol:
curl http result:
curl https result:
openssl s_client output:
proxy/load balancer path:
upstream scheme:
TLS termination point:
confirmed mismatch:
fix:
verification:
```

The incident is solved when each hop in the path has a documented scheme and the failing TLS client reaches a listener that actually speaks TLS.

## References

- [OpenSSL `s_client` documentation](https://docs.openssl.org/master/man1/openssl-s_client/)
- [Nginx proxy module documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [Nginx SSL module documentation](https://nginx.org/en/docs/http/ngx_http_ssl_module.html)
