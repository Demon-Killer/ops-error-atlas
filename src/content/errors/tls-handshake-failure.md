---
title: 'What causes TLS handshake failure'
description: A practical TLS handshake failure guide that separates certificate chain problems, SNI mismatch, protocol and cipher mismatch, mTLS failures, and proxy TLS termination mistakes.
slug: tls-handshake-failure
publishedAt: 2026-05-09
updatedAt: 2026-06-12
tags:
  - TLS
  - certificates
  - HTTPS
related:
  - x509-certificate-signed-by-unknown-authority
  - tls-certificate-verify-failed
  - tls-certificate-expired
  - ssl-wrong-version-number
  - tls-handshake-timeout
  - curl-28-operation-timed-out
---

`TLS handshake failure` means the client and server could not finish negotiating a secure session. TCP may have connected successfully, but TLS failed before the application could exchange normal HTTP data.

The boundary is:

```text
DNS -> TCP connect -> TLS ClientHello -> TLS negotiation -> HTTP request
```

If the failure is truly in the TLS handshake, application request handlers may not run and HTTP access logs may be missing or incomplete. Start with handshake evidence, not application code.

## What This Error Proves

It proves:

- TCP either reached the server or at least reached a TLS-speaking intermediary;
- the secure session did not complete;
- the failure happened before normal HTTP request processing;
- certificate selection, certificate validation, TLS version, cipher policy, client authentication, or proxy TLS mode are primary suspects.

It does not prove:

- the server is down;
- the certificate is always the root cause;
- the application handler returned an error;
- the fix is to disable certificate verification;
- the problem is visible from your laptop if production runs in a container, pod, proxy, or service mesh.

`TLS handshake timeout` is a deadline problem: the handshake did not finish in time. `certificate verify failed` is a client validation problem. `TLS handshake failure` is broader: the handshake was aborted or could not be negotiated.

## The Handshake Model

A simplified HTTPS handshake looks like this:

```text
client
  -> TCP connect to host:443
  -> ClientHello with SNI, supported TLS versions, cipher suites, ALPN
  -> server selects certificate and TLS parameters
  -> server sends certificate chain
  -> optional client certificate request for mTLS
  -> key exchange and Finished messages
  -> HTTP can begin
```

Different TLS versions have different message details, but the incident questions are stable:

- did the client send the expected SNI?
- did the server select the expected certificate?
- do the client and server share a TLS version and cipher policy?
- is client certificate authentication required?
- is a proxy opening another TLS connection upstream?
- did the failure happen on the client-to-proxy hop or the proxy-to-upstream hop?

## Start With The Exact Error Text

Collect the real error from the failing actor:

```text
client runtime:
command or service:
target host and port:
source environment:
exact error text:
timestamp:
proxy path:
```

Examples that point to different branches:

| Error shape | First branch |
| --- | --- |
| `certificate verify failed` | CA trust, hostname, chain, validity |
| `x509: certificate signed by unknown authority` | client trust store or missing intermediate |
| `no shared cipher` | cipher policy mismatch |
| `protocol version` | TLS version policy mismatch |
| `handshake failure alert` | server rejected negotiation; inspect logs and policy |
| `unknown ca` | mTLS client certificate trust or client-side CA trust |
| `bad certificate` | mTLS certificate, key, purpose, or chain |
| `wrong version number` | HTTPS sent to plaintext port or protocol mode mismatch |
| `unrecognized name` | SNI or virtual host selection |
| `EOF` or reset during handshake | proxy mode, server policy, middlebox, or abrupt close |

Do not normalize all of these to "TLS is broken." The exact message usually names the first useful branch.

## Confirm TCP Versus TLS

Use curl timing to separate connect from TLS:

```bash
curl -sS -o /dev/null \
  -w 'remote_ip=%{remote_ip} dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} total=%{time_total}\n' \
  https://<host>/
```

Interpretation:

- if `time_connect` never completes, this is not a TLS negotiation problem yet;
- if TCP connects and TLS fails, continue with handshake inspection;
- `time_appconnect - time_connect` approximates TLS duration for a successful request;
- failed requests need `curl -v` output because timing variables may be incomplete.

Run from the failing runtime, not only from your workstation:

```bash
docker exec -it <container> curl -v https://<host>/
kubectl exec -it <pod> -- curl -v https://<host>/
```

## Inspect The Handshake With SNI

Always include SNI for name-based HTTPS services:

```bash
openssl s_client -connect <host>:443 -servername <host> -brief
```

Show the full chain:

```bash
openssl s_client -connect <host>:443 -servername <host> -showcerts
```

Fail fast on certificate verification errors:

```bash
openssl s_client \
  -connect <host>:443 \
  -servername <host> \
  -verify_return_error
```

Test with a specific trust bundle:

```bash
openssl s_client \
  -connect <host>:443 \
  -servername <host> \
  -CAfile ca-bundle.pem \
  -verify_return_error
```

Without `-servername`, you may test the default certificate for the IP instead of the certificate used by real clients.

## Inspect Certificate Details

Save a certificate from `s_client -showcerts`, then inspect it:

```bash
openssl x509 -in leaf.pem -noout -subject -issuer -dates -ext subjectAltName
```

Check:

- the hostname appears in the Subject Alternative Name extension;
- the certificate is not expired and is already valid;
- the issuer chain leads to a CA trusted by the client;
- the server sends required intermediate certificates;
- the leaf certificate is for server authentication;
- private/internal certificates are trusted by the runtime that actually connects.

Common mistake: the certificate looks valid in a browser on a developer laptop, but fails in a minimal container because the container lacks the required CA bundle or corporate root certificate.

## Case 1: Certificate Chain Or Trust Store Failure

Strong signals:

- error contains `certificate verify failed`, `unknown authority`, or `unable to get local issuer certificate`;
- browser works but container, Java, Go, Python, or CI runner fails;
- server sends only the leaf certificate and omits an intermediate;
- private CA works on one host but not another;
- `curl -k` succeeds while normal `curl` fails.

Checks:

```bash
openssl s_client -connect <host>:443 -servername <host> -showcerts -verify_return_error
curl -v https://<host>/
curl --cacert ca-bundle.pem -v https://<host>/
```

Fix path:

- install the full server chain, including required intermediates;
- update the client trust store in the actual runtime image or host;
- pass the intended CA bundle explicitly only if that is the application design;
- avoid using `curl -k`, `--insecure`, or disabled verification as a production fix.

If the chain and hostname are correct but a specific runtime still fails, inspect that runtime's trust behavior. Java, Go, Node.js, Python, browsers, and system tools may not all use the same trust store.

## Case 2: SNI Selects The Wrong Certificate Or Virtual Host

Strong signals:

- `openssl s_client` succeeds with `-servername` and fails without it, or the reverse;
- the returned certificate belongs to a different hostname;
- multiple HTTPS sites share the same IP;
- the load balancer or proxy routes TLS based on hostname;
- server logs mention unrecognized name or default server selection.

Checks:

```bash
openssl s_client -connect <ip-or-host>:443 -servername <expected-host> -brief
openssl s_client -connect <ip-or-host>:443 -noservername -brief
```

Fix path:

- make the client send the intended SNI;
- map the hostname to the correct certificate and virtual host;
- configure proxy-to-upstream SNI when the upstream expects it;
- keep DNS name, HTTP Host header, SNI, and certificate SAN aligned.

SNI is a TLS extension defined for the handshake stage. It exists because the server must choose a certificate before it sees an HTTP request.

## Case 3: TLS Version Or Cipher Policy Mismatch

Strong signals:

- older clients fail while modern clients work, or the reverse;
- forcing TLS 1.2 or TLS 1.3 changes the result;
- errors mention protocol version, no shared cipher, handshake alert, or unsupported protocol;
- a recent security policy change removed legacy compatibility.

Checks:

```bash
openssl s_client -connect <host>:443 -servername <host> -tls1_2 -brief
openssl s_client -connect <host>:443 -servername <host> -tls1_3 -brief
openssl s_client -connect <host>:443 -servername <host> -cipher '<cipher-list>' -brief
```

Fix path:

- identify the failing client family and its TLS capabilities;
- align load balancer, proxy, and origin TLS policy;
- keep the policy as strict as the supported client population allows;
- do not re-enable obsolete protocols without an explicit compatibility decision.

This is a policy compatibility problem, not a reason to disable TLS verification.

## Case 4: ALPN Or HTTP/2 Negotiation Problems

Strong signals:

- HTTP/1.1 works but HTTP/2 fails, or the reverse;
- errors appear only through one CDN, load balancer, ingress, or service mesh;
- client and server negotiate an unexpected protocol;
- the connection completes TLS but fails immediately before useful HTTP data.

Checks:

```bash
openssl s_client -connect <host>:443 -servername <host> -alpn h2,http/1.1 -brief
curl -v --http1.1 https://<host>/
curl -v --http2 https://<host>/
```

Fix path:

- verify which ALPN protocol is negotiated;
- align HTTP/2 support across load balancer, proxy, and upstream;
- disable HTTP/2 on the affected hop only if evidence shows that hop is the failing point;
- avoid treating an HTTP/2 routing bug as a certificate problem.

ALPN is negotiated during TLS, so ALPN issues can appear before normal application logs.

## Case 5: mTLS Client Certificate Failure

Strong signals:

- the server requests a client certificate;
- only clients with certain certificates fail;
- errors mention `bad certificate`, `unknown ca`, `certificate required`, or handshake alert;
- local tests omit the client certificate even though production requires it;
- secrets or mounted certificate files differ across pods or hosts.

Checks:

```bash
openssl s_client \
  -connect <host>:443 \
  -servername <host> \
  -cert client.crt \
  -key client.key \
  -CAfile ca-bundle.pem \
  -verify_return_error \
  -brief
```

Validate certificate and key pairing:

```bash
openssl x509 -in client.crt -noout -modulus | openssl md5
openssl rsa -in client.key -noout -modulus | openssl md5
```

Fix path:

- provide the expected client certificate and key;
- include required client intermediates if the server expects them;
- install the client CA on the server or proxy that validates clients;
- verify certificate usage, validity window, and secret mount path;
- rotate expired client certificates through the normal secret-management process.

For mTLS, a successful browser test without a client certificate proves little about the production path.

## Case 6: HTTPS Sent To A Plain HTTP Port

Strong signals:

- OpenSSL reports `wrong version number`;
- curl receives plaintext HTTP while expecting HTTPS;
- the target port is wrong;
- proxy `proxy_pass` uses `https://` for an upstream that serves HTTP, or `http://` for an upstream that expects TLS.

Checks:

```bash
curl -v http://<host>:<port>/
curl -v https://<host>:<port>/
openssl s_client -connect <host>:<port> -servername <host> -brief
```

Fix path:

- verify the listener protocol on every hop;
- align load balancer listener, target group, reverse proxy, and upstream scheme;
- do not infer protocol from port number alone;
- document whether TLS terminates, passes through, or re-encrypts at each hop.

This is common during migrations from HTTP to HTTPS or when an upstream service moves behind a reverse proxy.

## Case 7: Proxy Or Load Balancer TLS Termination Mistake

A real path may include multiple handshakes:

```text
client -> CDN/load balancer -> ingress/Nginx/Envoy -> upstream service
```

Possible modes:

```text
TLS termination: client TLS ends at proxy, proxy sends HTTP upstream
TLS re-encryption: client TLS ends at proxy, proxy opens new TLS upstream
TLS passthrough: proxy forwards TLS without terminating it
```

Strong signals:

- direct origin works but proxy path fails;
- proxy path works for one hostname but fails for another;
- upstream certificate is valid only when upstream SNI is set;
- logs mention `SSL_do_handshake`, upstream SSL error, or handshake alert;
- a proxy is configured for passthrough but also tries to terminate TLS.

Nginx-oriented checks:

```bash
nginx -T | grep -E 'listen|ssl_|proxy_pass|proxy_ssl'
```

Fix path:

- draw every hop and label its protocol: HTTP or HTTPS;
- align listener protocol with upstream scheme;
- configure upstream SNI if upstream HTTPS is name-based;
- verify upstream certificate trust if the proxy validates upstream certificates;
- ensure timeout and retry behavior does not hide a deterministic TLS configuration error.

Do not assume "the certificate is fine" because the browser-to-load-balancer certificate is fine. The proxy-to-upstream certificate can be a different certificate.

## Case 8: Runtime-Specific TLS Behavior

Strong signals:

- `curl` on the host succeeds but application fails;
- browser succeeds but Java, Go, Node.js, Python, or a container fails;
- only one image tag, base image, or runtime version fails;
- corporate TLS interception exists on one network path;
- proxy variables differ between shell and service environment.

Checks:

```bash
env | grep -i proxy
docker exec -it <container> env | grep -i proxy
docker exec -it <container> curl -v https://<host>/
docker exec -it <container> openssl s_client -connect <host>:443 -servername <host> -brief
kubectl exec -it <pod> -- curl -v https://<host>/
```

Fix path:

- test from the process environment, not only from an interactive shell;
- compare trust store, proxy variables, DNS result, and client certificate files;
- verify service mesh sidecar and egress gateway behavior;
- rebuild minimal images with the required CA bundle if trust data is missing.

The same URL can use different DNS, proxy, source IP, trust store, and TLS library depending on runtime.

## Case 9: Server Configuration Or Key Material Problem

Strong signals:

- server starts with a certificate/key mismatch warning or error;
- only one backend instance fails;
- a recent certificate rotation affected some nodes;
- load balancer health checks pass on TCP but HTTPS clients fail;
- logs mention private key mismatch, missing certificate, or invalid chain.

Checks:

```bash
openssl x509 -in server.crt -noout -modulus | openssl md5
openssl rsa -in server.key -noout -modulus | openssl md5
openssl x509 -in server.crt -noout -subject -issuer -dates -ext subjectAltName
```

Fix path:

- deploy matching certificate and private key;
- include the expected intermediate chain;
- reload the TLS terminator safely;
- verify each backend instance, not only the load balancer hostname;
- keep certificate rotation atomic across replicas.

If only one backend fails, round-robin tests can make the incident look intermittent. Pin tests to individual backend IPs where possible.

## Packet Capture For Ambiguous Failures

Capture the handshake path:

```bash
tcpdump -tttt -nn -i any host <peer-ip> and port 443
```

Useful packet-level patterns:

| Pattern | Likely direction |
| --- | --- |
| TCP SYN retransmits | network path or listener, not TLS yet |
| ClientHello leaves, immediate RST returns | server/proxy rejects policy or protocol mode |
| ClientHello leaves, no response | server, proxy, firewall, return path, or timeout |
| server sends alert then closes | inspect alert, server logs, TLS policy |
| handshake completes, then HTTP fails | not a handshake failure; debug HTTP/application |

Packet capture does not decrypt TLS, but it can prove whether the handshake started, whether a reset or alert happened, and which side closed first.

## Decision Tree

```text
TLS handshake failure
|
+-- does TCP connect fail?
|   |
|   +-- debug route, firewall, listener, load balancer, packet loss
|
+-- error says certificate verify/unknown authority?
|   |
|   +-- inspect chain, hostname, trust store, runtime CA bundle
|
+-- returned certificate is for the wrong name?
|   |
|   +-- inspect SNI, virtual host mapping, upstream SNI
|
+-- old/new clients differ?
|   |
|   +-- inspect TLS version, cipher policy, library support
|
+-- mTLS required?
|   |
|   +-- inspect client cert, key, CA, secret mount, server trust
|
+-- wrong version number or plaintext response?
|   |
|   +-- inspect HTTP vs HTTPS mode on each hop
|
+-- works direct but fails through proxy?
|   |
|   +-- inspect termination, re-encryption, passthrough, upstream trust
|
+-- host works but app/container/pod fails?
    |
    +-- inspect runtime trust store, proxy variables, service mesh, egress
```

## What Not To Do

- Do not disable certificate verification as the permanent fix.
- Do not test without SNI and assume the result represents production.
- Do not debug HTTP handlers before proving the TLS handshake completes.
- Do not treat every TLS error as a certificate-chain problem.
- Do not change TLS versions or ciphers globally without identifying affected clients.
- Do not trust a browser-only test when production uses containers or custom runtimes.
- Do not ignore proxy-to-upstream TLS; it may be a separate handshake.
- Do not use `curl -k` except as a narrow diagnostic to isolate verification.

## Minimal Incident Note Template

```text
Symptom:
- target URL:
- host and port:
- failing client/runtime:
- exact error text:
- first seen:
- affected percentage:

TCP/TLS boundary:
- DNS result:
- TCP connect result:
- curl -v result:
- openssl s_client command:
- SNI used:
- ALPN result:
- TLS version:
- cipher:

Certificate evidence:
- leaf subject:
- subjectAltName:
- issuer:
- validity:
- chain sent by server:
- client trust bundle:
- verification result:

mTLS evidence:
- client cert path:
- client key path:
- client CA expected by server:
- secret mount or runtime config:

Proxy path:
- CDN/load balancer:
- ingress/reverse proxy:
- upstream scheme:
- TLS termination/re-encryption/passthrough:
- upstream SNI:

Packet/log evidence:
- tcpdump summary:
- server TLS logs:
- proxy TLS logs:
- backend-specific results:

Hypothesis:
- failing layer:
- supporting evidence:

Fix:
- change applied:
- validation command:
- rollback plan:
```

The incident is solved when the failing runtime can complete the intended TLS handshake, with the expected certificate, trust path, protocol, and proxy mode, without disabling verification.

## References

- [RFC 8446: The Transport Layer Security Protocol Version 1.3](https://www.rfc-editor.org/rfc/rfc8446)
- [RFC 6066: TLS Extension Definitions, including SNI](https://www.rfc-editor.org/rfc/rfc6066)
- [RFC 7301: TLS Application-Layer Protocol Negotiation Extension](https://www.rfc-editor.org/rfc/rfc7301)
- [OpenSSL `s_client` documentation](https://docs.openssl.org/3.1/man1/openssl-s_client/)
- [curl command line manual](https://curl.se/docs/manpage.html)
- [NGINX: Securing HTTP Traffic to Upstream Servers](https://docs.nginx.com/nginx/admin-guide/security-controls/securing-http-traffic-upstream/)
- [tcpdump manual page](https://www.tcpdump.org/manpages/tcpdump.1.html)
