---
title: 'What causes TLS handshake timeout'
description: A practical TLS handshake timeout guide that separates TCP connect delay, packet loss, SNI, certificate exchange, server CPU pressure, mTLS, and proxy TLS termination issues.
slug: tls-handshake-timeout
publishedAt: 2026-05-14
updatedAt: 2026-06-02
tags:
  - TLS
  - timeout
  - HTTPS
related:
  - tls-handshake-failure
  - curl-28-operation-timed-out
  - high-network-latency
  - x509-certificate-signed-by-unknown-authority
---

`TLS handshake timeout` means the secure session did not finish before the client, proxy, load balancer, or server-side timeout expired. TCP may already be connected, but the TLS negotiation did not reach the point where the application can send an HTTP request.

The first boundary is:

```text
DNS -> TCP connect -> TLS handshake -> HTTP request -> response
```

If the timeout happens in the TLS phase, application handlers, database calls, and HTTP response generation may not have run at all. Treat this as a connection-establishment incident until evidence proves otherwise.

## What This Error Proves

It proves:

- the client did not finish TLS negotiation within the configured deadline;
- the request probably did not reach normal HTTP application handling;
- the failure may be caused by network loss, server pressure, TLS configuration, certificate selection, client certificate handling, or a proxy mode mismatch.

It does not prove:

- the certificate is untrusted;
- the upstream application is slow;
- the domain points to the wrong IP;
- the server has no certificate;
- increasing the timeout is the correct fix.

`certificate verify failed` is a validation failure. `TLS handshake failure` is often an explicit protocol or certificate negotiation failure. `TLS handshake timeout` is a deadline problem: something did not answer, progress, or complete quickly enough.

## The TLS Handshake Path

A simplified HTTPS handshake path looks like this:

```text
client
  -> TCP connect to host:443
  -> ClientHello with SNI and ALPN
  -> server chooses certificate, protocol, and parameters
  -> certificate and key exchange messages
  -> optional client certificate for mTLS
  -> Finished messages
  -> HTTP request can begin
```

Different TLS versions and implementations vary in message details, but this model is enough for incident response. A timeout can occur before the server sees `ClientHello`, after the client sends `ClientHello`, while the server prepares a response, during client certificate exchange, or inside a proxy-to-upstream TLS hop.

## Start With Timing Evidence

Use `curl` to split the request into phases:

```bash
curl -sS -o /dev/null \
  -w 'remote_ip=%{remote_ip} dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
  https://<host>/
```

Important interpretation:

- `time_namelookup` is measured from the start until DNS resolution completes.
- `time_connect` is measured from the start until TCP connect completes.
- `time_appconnect` is measured from the start until the SSL/TLS handshake completes.
- The approximate TLS duration is `time_appconnect - time_connect`, not `time_appconnect` alone.
- If `time_connect` is also high, debug network path and listener pressure before TLS internals.

Run several samples from the affected client or region. One successful laptop test does not clear a production pod, container, CI runner, or customer network.

## Inspect The Handshake Correctly

Always include SNI when testing a name-based HTTPS service:

```bash
openssl s_client -connect <host>:443 -servername <host> -brief
```

Show the chain and negotiated details:

```bash
openssl s_client -connect <host>:443 -servername <host> -showcerts -status
```

Test protocol versions when client groups behave differently:

```bash
openssl s_client -connect <host>:443 -servername <host> -tls1_2 -brief
openssl s_client -connect <host>:443 -servername <host> -tls1_3 -brief
```

Test ALPN if HTTP/2 versus HTTP/1.1 behavior differs:

```bash
openssl s_client -connect <host>:443 -servername <host> -alpn h2,http/1.1 -brief
```

If mTLS is required, test with the same client certificate material:

```bash
openssl s_client \
  -connect <host>:443 \
  -servername <host> \
  -cert client.crt \
  -key client.key \
  -CAfile ca-bundle.pem \
  -brief
```

Without SNI, a server may return a default certificate or route to a default virtual host. That can create misleading failures that are not visible in real browser or application traffic.

## Capture Packet Evidence

When timing data is ambiguous, capture the wire behavior:

```bash
tcpdump -tttt -nn -i any host <server-ip> and port 443
```

Useful patterns:

| Packet pattern | Likely meaning |
| --- | --- |
| SYN retransmits before TLS starts | TCP path, firewall, listener, or packet loss |
| TCP connects, ClientHello leaves, no reply | server, proxy, return path, or middlebox issue |
| ServerHello/certificate starts but stalls | loss, MTU, server pressure, or large handshake path |
| many retransmissions during handshake | network loss or congestion |
| immediate RST after ClientHello | TLS policy, SNI, ALPN, or proxy mode mismatch |
| clean handshake but slow first byte | not a handshake timeout; debug HTTP/application path |

Packet capture cannot decrypt normal TLS contents, but it can show whether the handshake is making progress and where packet loss or resets occur.

## Case 1: TCP Connect Is Slow Too

Strong signals:

- `time_connect` is high or close to the final timeout;
- packet capture shows SYN retransmits;
- `openssl s_client` hangs before any TLS output;
- failures correlate with one region, subnet, node, or NAT gateway.

Debug direction:

- route selection and source IP;
- firewall, security group, or load balancer listener;
- packet loss, congestion, or asymmetric return path;
- exhausted listener backlog or overloaded front-end.

Fixing TLS ciphers or certificates will not solve a path that cannot complete TCP reliably.

## Case 2: TCP Connect Is Fast, TLS Is Slow

Strong signals:

- `time_connect` is low but `time_appconnect - time_connect` is high;
- packet capture shows TCP connection and ClientHello, but delayed server handshake response;
- failures occur under connection bursts;
- existing keepalive connections work while new HTTPS connections time out.

Debug direction:

- TLS termination CPU and handshake concurrency;
- certificate lookup or SNI routing;
- mTLS client certificate validation;
- upstream TLS mode if a proxy opens a second TLS connection;
- packet loss after TCP connect.

This is the branch where TLS-specific evidence matters most.

## Case 3: Packet Loss Or MTU Problems During Handshake

Strong signals:

- `mtr` or packet capture shows loss or retransmissions;
- small TCP tests connect, but TLS stalls;
- one network path or region fails more than others;
- the server sends certificate data, then progress pauses;
- large certificate chains or additional handshake data make the issue easier to reproduce.

Checks:

```bash
mtr -rwzc 50 <host>
tcpdump -tttt -nn -i any host <server-ip> and port 443
```

Fix path:

- fix packet loss or congestion on the affected route;
- check MTU and fragmentation behavior on VPN, tunnel, and cloud edges;
- compare direct origin, load balancer, CDN, and proxy paths;
- reduce unnecessary certificate chain size if the chain is unusually large.

Do not assume a successful TCP connect proves the path is healthy. TLS can still suffer from loss after the socket is established.

## Case 4: TLS Termination CPU Or Handshake Burst

Strong signals:

- failures appear during traffic bursts or deploy waves;
- CPU rises on load balancer, Nginx, Envoy, ingress, or origin;
- new connections time out while reused connections continue to work;
- `ss` shows many new or established 443 connections;
- handshake latency improves when traffic shifts away from one instance.

Checks:

```bash
top
vmstat 1 5
ss -tan sport = :443
```

Fix path:

- enable or improve client connection reuse;
- scale TLS termination capacity;
- inspect whether keepalive is disabled by clients or proxies;
- spread traffic across more healthy endpoints;
- verify session resumption behavior before changing cipher policy.

TLS handshakes are more expensive than reusing an existing connection. A retry storm can amplify the load by creating more fresh handshakes.

## Case 5: SNI Selects The Wrong Virtual Host

Strong signals:

- `openssl s_client` behaves differently with and without `-servername`;
- one hostname on the same IP fails while another works;
- the server returns a default certificate;
- the load balancer or reverse proxy routes TLS by hostname;
- logs show "unrecognized name" or default server handling.

Checks:

```bash
openssl s_client -connect <ip-or-host>:443 -servername <expected-host> -brief
openssl s_client -connect <ip-or-host>:443 -noservername -brief
```

Fix path:

- make clients send the correct SNI;
- map the hostname to the correct certificate and virtual host;
- for upstream TLS proxying, ensure the proxy sends the expected SNI to the upstream;
- keep `Host` header, SNI, and certificate SANs aligned.

SNI is defined as a TLS extension. It lets a client indicate the hostname during the handshake so the server can choose the correct certificate and virtual host before HTTP starts.

## Case 6: Protocol, Cipher, Or ALPN Mismatch

Strong signals:

- old clients fail while modern clients work, or the reverse;
- forcing `-tls1_2` or `-tls1_3` changes the result;
- ALPN negotiation differs between clients;
- proxy logs mention unsupported protocol, cipher, or alert.

Checks:

```bash
openssl s_client -connect <host>:443 -servername <host> -tls1_2 -brief
openssl s_client -connect <host>:443 -servername <host> -tls1_3 -brief
openssl s_client -connect <host>:443 -servername <host> -alpn h2,http/1.1 -brief
```

Fix path:

- define the supported client population before tightening TLS policy;
- align load balancer, proxy, and origin protocol policies;
- verify that HTTP/2 and HTTP/1.1 routing both work if ALPN is used;
- avoid enabling weak legacy protocols only to make a timeout disappear.

Mismatch often produces explicit handshake failure, but some proxies and middleboxes surface it as a timeout. Confirm with logs and packet evidence.

## Case 7: mTLS Client Certificate Path

Strong signals:

- the server requests a client certificate;
- only clients with certain certs fail;
- handshake stalls or fails after the server requests client authentication;
- certificate chain, private key, or client trust bundle differs by environment.

Checks:

```bash
openssl s_client \
  -connect <host>:443 \
  -servername <host> \
  -cert client.crt \
  -key client.key \
  -CAfile ca-bundle.pem \
  -brief
```

Fix path:

- confirm the client presents the expected certificate;
- verify private key and certificate match;
- include the required intermediate certificates if the server expects them;
- validate client certificate trust at the server or proxy;
- compare production runtime secret mounts against local test files.

For mTLS, a browser or local OpenSSL test without the client certificate does not reproduce the production path.

## Case 8: Proxy Or Load Balancer TLS Mode Mismatch

For this chain:

```text
client -> load balancer -> reverse proxy -> upstream
```

there may be more than one TLS handshake:

```text
client TLS to load balancer
load balancer TLS or plaintext to reverse proxy
reverse proxy TLS or plaintext to upstream
```

Strong signals:

- direct origin works, but traffic through the proxy times out;
- proxy expects HTTPS but upstream serves HTTP, or the reverse;
- one hop terminates TLS while another expects pass-through;
- upstream SNI is missing or wrong;
- logs show `SSL_do_handshake`, upstream handshake timeout, or connection reset during handshake.

Nginx checks:

```bash
nginx -T | grep -E 'listen|ssl_|proxy_pass|proxy_ssl'
```

Fix path:

- decide exactly where TLS terminates;
- align `http://` versus `https://` for each upstream hop;
- send upstream SNI when the upstream certificate or virtual host requires it;
- set upstream verification intentionally, not accidentally;
- align timeout budgets across load balancer, proxy, and upstream.

In Nginx upstream HTTPS configurations, directives such as `proxy_ssl_server_name`, `proxy_ssl_name`, and upstream certificate verification can decide whether the proxy opens the correct TLS session.

## Case 9: Runtime Or Environment Difference

Strong signals:

- laptop tests pass, but container, pod, or CI runner fails;
- only one Kubernetes node, subnet, or egress gateway is affected;
- corporate proxy, service mesh, or outbound gateway changes TLS behavior;
- runtime trust store or client certificate mount differs.

Checks:

```bash
docker exec -it <container> curl -v https://<host>/
docker exec -it <container> openssl s_client -connect <host>:443 -servername <host> -brief
kubectl exec -it <pod> -- curl -v https://<host>/
kubectl exec -it <pod> -- openssl s_client -connect <host>:443 -servername <host> -brief
```

Fix path:

- test from the failing runtime, not a nearby shell;
- compare DNS result, source IP, proxy variables, and certificate files;
- inspect service mesh and egress policy;
- verify that outbound TLS is not intercepted or rewritten differently.

The same URL can follow different paths from a laptop, node, pod, and customer network.

## Decision Tree

```text
TLS handshake timeout
|
+-- is TCP connect slow too?
|   |
|   +-- debug route, firewall, packet loss, listener, backlog
|
+-- TCP fast but TLS slow?
|   |
|   +-- inspect ClientHello, server response, CPU, SNI, mTLS
|
+-- works with keepalive but new connections fail?
|   |
|   +-- inspect handshake burst, TLS termination capacity, retries
|
+-- fails only through proxy or load balancer?
|   |
|   +-- inspect TLS termination point, upstream protocol, upstream SNI
|
+-- fails only for some hostnames on same IP?
|   |
|   +-- inspect SNI, virtual host mapping, certificate selection
|
+-- fails only for old/new clients?
|   |
|   +-- inspect TLS versions, cipher suites, ALPN
|
+-- fails only in container/pod/CI?
    |
    +-- inspect runtime path, proxy, egress, service mesh, mounted certs
```

## What Not To Do

- Do not debug HTTP handlers until TLS completion is proven.
- Do not run `openssl s_client` without SNI and trust the result.
- Do not treat every TLS timeout as a certificate trust problem.
- Do not raise timeouts before checking packet loss, CPU, and retry storms.
- Do not test only from a laptop when production runs in a pod or container.
- Do not assume one TLS handshake exists in a proxy chain; there may be several.
- Do not disable certificate verification as a production fix.
- Do not weaken TLS protocol policy without knowing which real clients require it.

## Minimal Incident Note Template

```text
Symptom:
- URL:
- client/runtime:
- affected region/subnet/node:
- error text:
- timeout value:

Timing:
- curl time_namelookup:
- curl time_connect:
- curl time_appconnect:
- estimated TLS duration:
- curl time_starttransfer:
- repeated sample count:

Handshake:
- openssl command used:
- SNI used:
- TLS version:
- ALPN:
- certificate chain:
- mTLS required:

Network:
- server IP:
- packet capture summary:
- retransmissions:
- route/source IP:
- firewall/security group:

Proxy path:
- TLS termination point:
- load balancer listener:
- reverse proxy mode:
- upstream protocol:
- upstream SNI:

Hypothesis:
- failing layer:
- evidence:

Fix:
- change:
- validation:
```

The incident is solved when the same failing client or runtime can complete the intended TLS handshake repeatedly, within the expected timeout budget, through the same proxy path.

## References

- [RFC 8446: The Transport Layer Security Protocol Version 1.3](https://www.rfc-editor.org/rfc/rfc8446)
- [RFC 6066: TLS Extension Definitions, including SNI](https://www.rfc-editor.org/rfc/rfc6066)
- [OpenSSL `s_client` documentation](https://docs.openssl.org/3.1/man1/openssl-s_client/)
- [curl write-out variables](https://curl.se/docs/manpage.html)
- [NGINX: Securing HTTP Traffic to Upstream Servers](https://docs.nginx.com/nginx/admin-guide/security-controls/securing-http-traffic-upstream/)
- [tcpdump manual page](https://www.tcpdump.org/manpages/tcpdump.1.html)
