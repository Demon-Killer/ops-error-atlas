---
title: 'What causes "i/o timeout" in backend systems'
description: A practical i/o timeout guide for backend services that separates DNS, TCP connect, TLS, read deadlines, storage stalls, dependency latency, and overly aggressive timeout budgets.
slug: io-timeout
publishedAt: 2026-05-02
updatedAt: 2026-05-29
tags:
  - timeout
  - backend
  - networking
related:
  - read-connection-timed-out
  - curl-28-operation-timed-out
  - high-network-latency
  - tcp-retransmissions
---

`i/o timeout` means an input or output operation did not complete before a deadline. In backend systems, that operation might be DNS lookup, TCP connect, TLS handshake, request write, response read, database socket I/O, object storage transfer, disk I/O, or a queue/storage dependency hidden behind a driver.

The phrase is broad. The fix depends on the phase.

In Go, `i/o timeout` is especially common because network I/O deadlines are part of the `net.Conn` contract. The Go `net` package documents that when a connection deadline is exceeded, I/O methods return an error that wraps `os.ErrDeadlineExceeded`; timeout errors also report `Timeout() == true`, though other errors can also do that. That means the text alone is not enough. You still need the dependency, phase, deadline, and request context.

The useful question is:

```text
Which dependency operation timed out, how much of the deadline was spent before real I/O began, and what evidence identifies the slow phase?
```

Do not raise a global timeout until you can answer that.

## Build the dependency timeline first

For every failing call, write the timeline:

```text
caller receives request
  -> local queue / worker wait
  -> connection pool wait
  -> DNS lookup
  -> TCP connect
  -> TLS handshake
  -> request write
  -> first byte / first row / first result
  -> response body / result scan / file transfer
  -> caller returns
```

Then attach timings and deadlines:

```text
dependency:
operation:
total caller deadline:
pool wait:
dns:
connect:
tls:
write:
first byte / first result:
read / scan / transfer:
error:
```

This separates remote slowness from local waiting. If a request spends 900 ms waiting for a database connection from a local pool and then times out at 1 second during read, increasing the remote read timeout is probably the wrong fix. The real problem may be pool saturation or slow queries holding connections too long.

## Phase map

| Phase | Typical symptom | First branch |
| --- | --- | --- |
| Local queue or pool wait | timeout before network call really starts | worker pool, DB pool, HTTP agent, concurrency limits |
| DNS lookup | `lookup ... i/o timeout`, high DNS time | resolver health, service discovery, search domains, bad nameserver |
| TCP connect | connect timeout, SYN retries, no first byte | routing, firewall, listener, accept backlog, one bad endpoint |
| TLS handshake | TLS handshake timeout | SNI, certificate path, protocol/cipher, CPU/load, middle proxy |
| Request write | timeout while uploading or sending body | large payload, server not reading, body limits, proxy buffering |
| First byte/read headers | connect is fast, first byte is slow | upstream handler, database/cache/API latency, queueing |
| Response body/read stream | first byte arrives, body stalls | streaming, large export, packet loss, proxy idle timeout |
| Storage I/O | disk await high, reads/writes stall | local disk, network storage, filesystem, database storage layer |
| Retry budget | several attempts consume caller deadline | retry storm, no total deadline, same bad endpoint |

The same top-level error can appear in all of these branches. The phase is the diagnosis entry point.

## Go: distinguish deadline, context, and socket timeout

In Go services, three timeout concepts often get mixed:

| Signal | What it usually means | What to inspect |
| --- | --- | --- |
| `i/o timeout` | a network or file I/O deadline expired | `net.Conn` deadline, HTTP transport timeout, driver socket deadline |
| `context deadline exceeded` | a request context deadline expired | caller deadline, `context.WithTimeout`, propagation chain |
| `net/http: timeout awaiting response headers` | HTTP client waited too long for response headers | `ResponseHeaderTimeout`, upstream handler/dependency latency |
| `Client.Timeout exceeded while awaiting headers` | total `http.Client.Timeout` expired before headers | whole request budget, including redirects and body reads |

Do not collapse these into one log bucket. A context deadline may cancel an operation before the socket itself times out. A socket read deadline may fire while the context still has time left. A connection pool wait may consume most of the request budget before DNS or TCP begins.

## Instrument Go HTTP clients with httptrace

For Go HTTP dependencies, `net/http/httptrace` gives hooks for DNS, connect, TLS, first response byte, and connection reuse. Use it to prove where time is spent.

```go
package main

import (
	"context"
	"log"
	"net/http"
	"net/http/httptrace"
	"time"
)

func call(ctx context.Context, url string) error {
	start := time.Now()
	marks := map[string]time.Duration{}

	trace := &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) {
			marks["dns_start"] = time.Since(start)
		},
		DNSDone: func(httptrace.DNSDoneInfo) {
			marks["dns_done"] = time.Since(start)
		},
		ConnectStart: func(network, addr string) {
			marks["connect_start"] = time.Since(start)
		},
		ConnectDone: func(network, addr string, err error) {
			marks["connect_done"] = time.Since(start)
		},
		TLSHandshakeStart: func() {
			marks["tls_start"] = time.Since(start)
		},
		TLSHandshakeDone: func(_ any, err error) {
			marks["tls_done"] = time.Since(start)
		},
		GotConn: func(info httptrace.GotConnInfo) {
			marks["got_conn"] = time.Since(start)
			log.Printf("got_conn reused=%v was_idle=%v idle=%s", info.Reused, info.WasIdle, info.IdleTime)
		},
		WroteRequest: func(httptrace.WroteRequestInfo) {
			marks["wrote_request"] = time.Since(start)
		},
		GotFirstResponseByte: func() {
			marks["first_byte"] = time.Since(start)
		},
	}

	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), http.MethodGet, url, nil)
	if err != nil {
		return err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("http_error url=%s elapsed=%s marks=%v err=%v", url, time.Since(start), marks, err)
		return err
	}
	defer resp.Body.Close()

	log.Printf("http_done url=%s status=%d elapsed=%s marks=%v", url, resp.StatusCode, time.Since(start), marks)
	return nil
}
```

This is example instrumentation. In production, use structured logs or tracing spans and record the dependency name, route, status, attempt number, pool wait, and total deadline. The key point is that a single `i/o timeout` log line should become a phase-specific event.

## Configure timeouts by phase, not as one number

For Go HTTP clients, avoid relying on an unbounded default client in production. Configure a transport deliberately:

```go
transport := &http.Transport{
	DialContext: (&net.Dialer{
		Timeout:   2 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
	TLSHandshakeTimeout:   2 * time.Second,
	ResponseHeaderTimeout: 3 * time.Second,
	ExpectContinueTimeout: 1 * time.Second,
	IdleConnTimeout:       30 * time.Second,
	MaxIdleConns:          100,
	MaxIdleConnsPerHost:   20,
}

client := &http.Client{
	Transport: transport,
	Timeout:   5 * time.Second,
}
```

This is an example shape, not a universal recommendation. The values must fit your service-level objective, dependency behavior, and caller deadline.

What matters:

- connect timeout should fail bad routes and dead endpoints quickly;
- TLS handshake timeout should be separate from application latency;
- response header timeout should expose slow handlers before the caller gives up;
- total client timeout should cover the whole request and all body reads;
- retries must fit inside one total budget.

## Commands that separate network phases

### HTTP dependency timing

```bash
curl -sS -o /dev/null \
  -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
  https://dependency.example.com/path
```

Interpretation:

- high `dns` means resolver or service discovery branch;
- high `connect` means TCP path/listener branch;
- high `tls` means handshake/certificate/SNI branch;
- high `first_byte` means upstream processing or dependency latency;
- high `total` with normal first byte means response body/transfer branch.

If DNS returns several addresses, test a specific target:

```bash
curl -v --resolve dependency.example.com:443:10.0.3.17 https://dependency.example.com/path
```

This helps find one bad endpoint behind DNS or a load balancer.

### DNS branch

```bash
dig +tries=1 +time=2 dependency.example.com
dig +tries=1 +time=2 @<resolver-ip> dependency.example.com
getent hosts dependency.example.com
```

Check:

- whether one resolver is slow or unreachable;
- whether search-domain expansion creates repeated failed lookups;
- whether the application and your shell use the same resolver path;
- whether the failing pod/container has different DNS config.

### TCP connect branch

```bash
nc -vz -w 3 <dependency-ip> <port>
ss -tan state syn-sent
ss -s
netstat -s | grep -Ei 'retrans|timeout|reset|listen|overflow'
```

High connect time points to routing, firewall, listener, accept backlog, overloaded host, or packet loss. Test from the same runtime environment as the application, not only from your laptop.

### TLS branch

```bash
openssl s_client -connect dependency.example.com:443 -servername dependency.example.com -showcerts
curl -vk https://dependency.example.com/path
```

Check SNI, certificate chain, protocol version, proxy interception, and whether the port really expects TLS.

### Packet-level branch

```bash
tcpdump -tttt -nn -i any host <dependency-ip> and port <port>
mtr -rw <dependency-ip>
```

Use packet capture when logs disagree. It can prove whether packets stop, retransmit, reset, or arrive after the application deadline. For TLS traffic, payload is encrypted, but TCP timing and close behavior are still visible.

### Storage branch

```bash
iostat -xz 1 5
pidstat -d 1 5
```

For databases, use the database's own wait and slow-query tools. A client-side `i/o timeout` can be caused by server-side lock waits, slow storage, saturated connection pools, or queries that continue after the client deadline.

## Case 1: DNS timeout

Strong signals:

- error mentions `lookup`;
- `curl` shows high `time_namelookup`;
- only some pods/nodes fail;
- resolver logs show timeout or SERVFAIL patterns;
- failures started after DNS, service discovery, or network policy changes.

Fix path:

1. Test the same hostname from the same pod/container/host.
2. Compare resolvers configured in `/etc/resolv.conf`.
3. Check whether search domains cause repeated slow lookups.
4. Verify service discovery health and DNS cache behavior.
5. Avoid hiding resolver failures by raising every application timeout.

DNS time is part of the request budget. If DNS consumes most of the deadline, the remote service may never receive the request.

## Case 2: TCP connect timeout

Strong signals:

- DNS is fast, but connect is slow or fails;
- `ss` shows sockets stuck in `SYN-SENT`;
- packet capture shows SYN retransmissions or no SYN-ACK;
- only one endpoint, node, subnet, or availability zone fails;
- a firewall or load balancer silently drops packets.

Fix path:

- verify host, port, and route from the application namespace;
- check firewall/security group/network policy;
- check listener health and accept backlog;
- compare a bad endpoint with a healthy peer;
- remove bad targets from rotation while preserving evidence.

Raising connect timeout makes sense only when slow connects are expected and useful to wait for. It does not fix blackholed routes or a saturated listener.

## Case 3: TLS handshake timeout

Strong signals:

- TCP connect succeeds, TLS does not complete;
- `curl -vk` or `openssl s_client` hangs or fails during handshake;
- error appears after TLS termination or certificate changes;
- only virtual-hosted HTTPS endpoints fail.

Fix path:

- verify SNI with `openssl s_client -servername`;
- confirm the port expects TLS;
- inspect certificate chain and trust roots;
- check TLS protocol/cipher compatibility;
- check CPU or load on TLS terminators if handshakes are slow under load.

Do not classify TLS handshake timeout as general network latency until TCP connect and SNI are verified.

## Case 4: Timeout before first byte

Strong signals:

- DNS, connect, and TLS are normal;
- `time_starttransfer` or `GotFirstResponseByte` is high;
- server access log shows long handler time;
- database/cache/API dependency latency spikes at the same timestamp;
- worker pool or queue depth is high.

Likely causes:

- slow database query or lock wait;
- cache outage causing slow fallback;
- external API call with no shorter timeout;
- worker/thread/goroutine pool saturation;
- request queueing before handler execution;
- retry storm increasing dependency load.

Fix path:

1. Add per-dependency timing inside the handler.
2. Give each dependency a deadline shorter than the handler deadline.
3. Return controlled errors before callers time out.
4. Reduce fan-out, cache safely, paginate, or move long work async.
5. Avoid increasing read timeout until the slow dependency is understood.

First-byte delay is usually application or dependency latency, not basic reachability.

## Case 5: Timeout during response body

Strong signals:

- first byte arrives, then transfer stalls;
- large downloads, exports, or streaming endpoints fail;
- packet capture shows long gaps between data packets;
- proxy logs show read/idle timeout;
- client deadline expires while server may still be generating body.

Fix path:

- separate interactive API routes from bulk export routes;
- stream deliberately and log chunk timing;
- use background jobs plus downloadable artifacts for long exports;
- support pagination or resumable downloads where appropriate;
- align client, proxy, app, and storage read/idle timeouts;
- propagate cancellation when the caller leaves.

Do not solve a product-flow problem only by raising the read deadline.

## Case 6: Storage or database I/O timeout

Strong signals:

- error comes from a database, object storage, file, or network storage client;
- server-side wait events or slow logs match the timeout window;
- disk await or storage latency spikes;
- connection pool wait increases before the timeout;
- query continues on the server after the client timed out.

Fix path:

- separate pool wait, server execution time, and result read time;
- log query or operation identifiers safely;
- inspect database wait events, locks, slow queries, and disk I/O;
- cap query deadlines under the caller deadline;
- cancel server-side work when the client times out if the driver/database supports it;
- size pools according to downstream capacity, not just local concurrency.

Increasing a database connection pool can make local wait look better while overloading the database. Treat pool size as a capacity contract.

## Case 7: Retry budget turns one timeout into an outage

Retries can convert a small latency spike into overload.

Strong signals:

- timeout count rises with request volume;
- dependency saturation worsens after retries begin;
- several attempts target the same bad endpoint;
- total retry time exceeds the caller deadline;
- write operations are retried without idempotency protection.

Fix path:

- use one total deadline across all attempts;
- retry only idempotent operations or operations with idempotency keys;
- add exponential backoff with jitter;
- avoid retrying known-bad endpoints immediately;
- use circuit breaking or load shedding when the dependency is saturated.

Timeouts and retries must be designed together. A retry policy without a total deadline is an outage amplifier.

## Timeout budgeting

Use a layered timeout budget so the component closest to the real problem fails with useful evidence.

Example for a normal interactive API:

```text
database query timeout:       2s
external API timeout:         2s
application handler deadline: 3s
proxy timeout:                5s
client timeout:               10s
```

These values are examples. The important properties are:

- dependency deadlines are shorter than the handler deadline;
- the app can return a controlled error before the proxy/client gives up;
- retries fit within the same caller deadline;
- long-running workflows have explicit async/export designs;
- metrics distinguish pool wait, connect, TLS, first byte, body, and storage time.

If every layer is set to 30 seconds, failures become slow and ambiguous. The wrong layer will often report the symptom.

## What not to do

- Do not assume `i/o timeout` means "the network is slow."
- Do not raise global timeouts before identifying the phase.
- Do not ignore local queue or pool wait.
- Do not test only from a laptop when the service runs in a pod, container, or private subnet.
- Do not add retries without a total deadline and idempotency rules.
- Do not make every layer use the same timeout value.
- Do not group DNS, connect, TLS, first-byte, and body timeouts into one alert without tags.

## Decision tree

```text
i/o timeout
|
+-- did the operation wait in a local pool first?
|   |
|   +-- inspect pool saturation, worker queueing, concurrency limits
|
+-- DNS time high or lookup error?
|   |
|   +-- inspect resolver, service discovery, search domains, pod DNS config
|
+-- connect time high?
|   |
|   +-- inspect route, firewall, listener, accept backlog, bad endpoint
|
+-- TLS handshake slow?
|   |
|   +-- inspect SNI, certificate chain, protocol/cipher, TLS terminator load
|
+-- first byte slow?
|   |
|   +-- inspect upstream handler, dependency latency, worker saturation
|
+-- body transfer stalls?
|   |
|   +-- inspect streaming/export path, packet gaps, proxy idle timeout
|
+-- storage/database client reports timeout?
    |
    +-- separate pool wait, server execution, result read, storage wait events
```

## Minimal incident note template

```text
Symptom:
- error text:
- dependency:
- operation:
- caller route:
- first seen:

Deadline evidence:
- caller deadline:
- dependency timeout:
- context error:
- socket/file error:
- retry attempt:
- total retry budget:

Phase timings:
- local queue wait:
- pool wait:
- DNS:
- TCP connect:
- TLS:
- request write:
- first byte / first result:
- read / scan / transfer:

Dependency evidence:
- server access log:
- slow query / wait event:
- storage latency:
- proxy/load balancer log:
- packet capture:

Hypothesis:
- timed-out phase:
- evidence:

Fix:
- code/config/capacity change:
- validation command:
```

The incident is solved when the next `i/o timeout` log can be assigned to a precise phase automatically, not when the timeout value is larger.

## References

- [Go `net` package: connection deadlines and timeout errors](https://pkg.go.dev/net)
- [Go `net/http` package: `Transport` timeout fields](https://pkg.go.dev/net/http)
- [Go `net/http/httptrace` package](https://pkg.go.dev/net/http/httptrace)
- [Go `context` package: `DeadlineExceeded`](https://pkg.go.dev/context)
- [curl man page: `--write-out`, `--connect-timeout`, and timing variables](https://curl.se/docs/manpage.html)
- [Linux `tcp(7)` manual page](https://man7.org/linux/man-pages/man7/tcp.7.html)
- [Linux `socket(7)` manual page](https://man7.org/linux/man-pages/man7/socket.7.html)
