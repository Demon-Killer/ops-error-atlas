---
title: 'What does "connection reset by peer" mean?'
description: A practical guide to connection reset by peer that explains TCP resets, how to prove who sent the RST, and what to check in Linux, proxies, and upstream services.
slug: connection-reset-by-peer
publishedAt: 2026-05-13
updatedAt: 2026-06-17
tags:
  - TCP
  - Linux
  - sockets
related:
  - broken-pipe
  - connection-refused
  - connect-timed-out
  - socket-hang-up
  - tcp-retransmissions
  - upstream-prematurely-closed-connection
popular: true
---

`connection reset by peer` means the remote side, or something acting on behalf of it, abruptly reset the TCP connection. Instead of closing cleanly with `FIN`, the peer sent `RST`, so your process immediately loses the socket. In production, the reset may come from the application, a proxy, a load balancer, a firewall, or a server that restarted while the connection was active.

The useful question is not "why did the network fail?" It is:

```text
Which hop sent the RST, during which phase of the exchange, and what changed around that timestamp?
```

That framing prevents a common mistake: treating every reset as random packet loss. A reset is an explicit TCP signal. The investigation should preserve where it came from.

## What it means

At the TCP layer, a reset is an abrupt stop signal. The important detail is that `peer` does not always mean the final application server. It can also be:

- a reverse proxy;
- a load balancer;
- a service mesh sidecar;
- a firewall or NAT device;
- a kernel on the remote host.

Your first job is to prove where the reset came from.

## A realistic incident shape

This is an example pattern, not a universal explanation.

A client service starts logging:

```text
read tcp 10.12.1.25:51742->10.20.4.18:443: read: connection reset by peer
```

At the same time, Nginx logs on an intermediate proxy show:

```text
upstream prematurely closed connection while reading response header from upstream
```

The wrong first move is to increase every timeout. The better move is to answer three questions:

1. Did the reset arrive while connecting, writing the request, reading response headers, reading the body, or reusing an idle connection?
2. Did the reset come from the final upstream, a proxy, a load balancer, or the local host?
3. Did the reset begin after a deploy, restart, health-check change, idle-timeout change, or traffic shift?

## Common causes

- The upstream process crashed, restarted, or closed the socket under load.
- A proxy or load balancer closed an idle connection.
- Client and server disagreed about protocol behavior, such as sending HTTPS to an HTTP port.
- A firewall or middlebox reset the connection after an idle period or policy match.
- The server rejected malformed headers, oversized payloads, or invalid protocol framing.
- Keepalive reuse exposed a stale connection.

## Reset phase matters

The same error string can mean different things depending on when it appears.

| Phase | What to inspect first |
| --- | --- |
| during connect | listener, firewall reject, load balancer target, route |
| during request write | peer closed before reading full request, payload limit, protocol mismatch |
| while reading response headers | upstream crash, proxy close, app timeout, bad gateway path |
| mid-response body | streaming bug, large download/export, client/proxy timeout |
| after idle reuse | keepalive lifetime mismatch, stale pooled connection |

Log the phase explicitly. If your application only logs the final exception text, add fields for method, URL, remote IP, reused connection, bytes written, bytes read, and elapsed time.

## Fast triage order

Use this order when you see the error in logs:

1. Confirm whether the reset happens during connect, request write, response read, or idle reuse.
2. Check whether it affects one host, one upstream instance, one endpoint, or all traffic.
3. Compare application logs on both sides at the same timestamp.
4. Capture packets around the failure and identify who sends `RST`.
5. Check proxy, load balancer, and keepalive timeout settings.
6. Inspect deploy, restart, OOM, and crash events near the first reset.

## Preserve the connection tuple

Before changing settings, capture:

```text
client host / pod / container:
client local IP and port:
destination hostname:
resolved destination IP:
destination port:
protocol:
request path or operation:
timestamp:
connection phase:
was the connection reused:
bytes written:
bytes read:
```

Without the tuple, it is easy to debug the wrong backend or the wrong network segment.

## How to tell who sent the reset

Packet capture is the most direct proof.

```bash
tcpdump -nn -i any host <peer-ip> and tcp
```

Look for a packet with the `R` flag. The source IP of that packet is the side that sent the reset.

Useful hints:

| Observation | Likely direction |
| --- | --- |
| `RST` comes from upstream IP | Upstream app, host kernel, or upstream-side proxy |
| `RST` comes from load balancer IP | Load balancer timeout or policy |
| Reset happens after idle time | Keepalive or idle timeout mismatch |
| Reset happens during large response | Streaming, buffering, or write timeout |
| Reset appears during deploy | Restart, missing draining, or stale connection reuse |
| Reset happens only for one endpoint | Application behavior or payload-specific failure |

## Commands to try

### Check active sockets

```bash
ss -tanp
ss -tan state established
```

Use this to see whether connections pile up, close quickly, or stay in unusual states.

### Inspect service logs

```bash
journalctl -u your-service --since -30m
journalctl -u nginx --since -30m
```

Check for restarts, panics, crashes, worker exits, or upstream close messages near the reset timestamp.

### Test with curl

```bash
curl -v http://host:port/path
curl -H 'Connection: close' -v http://host:port/path
```

If `Connection: close` changes behavior, suspect keepalive reuse.

### Capture packets

```bash
tcpdump -nn -i any host <peer-ip> and port <port>
```

If there are proxies between client and server, capture from the client side and the upstream side if possible. A reset on one segment may not be visible on another segment.

### Check kernel counters

```bash
netstat -s | grep -i reset
netstat -s | grep -i retrans
```

Counters do not identify root cause alone, but they help confirm whether resets and retransmissions are increasing during the incident.

## Case 1: Upstream process crash or restart

Strong signals:

- resets begin near a deploy or restart;
- only one upstream instance is affected;
- upstream logs show panic, crash, OOM kill, worker exit, or graceful shutdown gap;
- load balancer health checks are slower than traffic routing changes;
- packet capture shows RST from the upstream host.

Checks:

```bash
journalctl -u your-service --since -30m
dmesg -T | egrep -i 'oom|killed|segfault'
ss -tanp '( sport = :8080 )'
```

Fix path:

- fix the crash or shutdown path;
- add connection draining before removing or restarting instances;
- remove sick targets from rotation;
- verify one backend at a time.

## Case 2: Keepalive lifetime mismatch

Strong signals:

- first request on a new connection works;
- reused connections fail;
- `Connection: close` changes behavior;
- reset happens after a repeatable idle interval;
- proxy or upstream keepalive timeout is shorter than the client pool lifetime.

Checks:

```bash
curl -H 'Connection: close' -v http://host:port/path
grep -R "keepalive" /etc/nginx /etc/haproxy 2>/dev/null
```

Fix path:

- make clients retire idle connections before upstream/proxy idle timeout;
- align load balancer, proxy, and upstream keepalive settings;
- avoid unlimited idle reuse;
- test under the same idle interval that triggers the reset.

## Case 3: Protocol mismatch or wrong port

Strong signals:

- reset occurs immediately after bytes are sent;
- HTTPS is sent to an HTTP listener or the reverse;
- one proxy hop uses the wrong upstream scheme;
- TLS inspection or mTLS policy changed;
- `SSL wrong version number` appears in adjacent logs.

Checks:

```bash
curl -v http://<host>:<port>/
curl -vk https://<host>:<port>/
openssl s_client -connect <host>:<port> -servername <host>
```

Fix path:

- document the expected scheme for each hop;
- fix `proxy_pass http://` vs `https://`;
- verify TLS termination points;
- test direct upstream and public path separately.

## Case 4: Payload or response-size behavior

Strong signals:

- small requests work, large requests fail;
- failures concentrate on export, upload, report, or streaming routes;
- resets happen while reading response body or writing request body;
- proxy logs show client abort, upstream close, or size-limit errors.

Fix path:

- confirm request and response size;
- inspect proxy buffering and body limits;
- move long exports to async jobs where appropriate;
- make streaming code cancellation-aware;
- do not increase every timeout before proving the phase.

## How it differs from related errors

### `broken pipe`

Usually means your process tried to write after the other side had already closed or reset the connection.

### `connection refused`

Usually means the connection was rejected during connection setup because nothing was listening or the host actively refused it.

### `upstream prematurely closed connection`

This is Nginx's higher-level interpretation of an upstream closing earlier than expected. It may be caused by the same reset event.

### `socket hang up`

In Node.js and some HTTP clients, `socket hang up` is often another surface form of an early close or reset. Keep the same phase-based investigation.

## How to fix it

### If the upstream app resets the connection

- inspect crashes, panics, OOM kills, and deploy events;
- check whether only one instance is affected;
- inspect endpoint-specific failures and large payload behavior.

### If idle timeout mismatch is the trigger

- align client, proxy, load balancer, and upstream idle timeouts;
- test disabling keepalive temporarily to confirm the theory;
- avoid reusing connections longer than the upstream accepts.

### If a proxy or load balancer sends the reset

- inspect policy, idle timeout, max request size, and backend health;
- check whether the reset maps to one backend target;
- review connection draining during deploys.

### If protocol mismatch is the trigger

- confirm whether each hop expects HTTP or HTTPS;
- check ports and upstream schemes;
- verify TLS termination points.

## Decision tree

```text
connection reset by peer
|
+-- Which phase failed?
|   +-- connect -> listener, active reject, route, load balancer target
|   +-- write -> peer closed before reading request, payload/protocol issue
|   +-- read headers -> upstream crash, proxy close, app timeout
|   +-- read body -> streaming/export/large response behavior
|   +-- idle reuse -> keepalive lifetime mismatch
|
+-- Which side sent RST?
|   +-- capture packets and compare client/proxy/upstream logs
|
+-- Started after deploy or traffic shift?
|   +-- inspect restarts, target health, draining, one-node failures
|
+-- Only one route or payload size?
    +-- inspect application behavior, buffering, payload limits
```

## What not to assume

- Do not assume it is a random network problem.
- Do not assume the application server is always the peer.
- Do not fix it by only increasing timeouts.
- Do not ignore load balancers, service mesh, or keepalive reuse.

## Incident note template

```text
error text:
client host / pod / container:
client local IP:port:
destination hostname:
resolved destination IP:
destination port:
request path:
connection phase:
reused connection:
bytes written/read:
RST packet source:
client log timestamp:
proxy/load balancer log:
upstream application log:
recent deploy/restart:
confirmed cause:
fix:
verification command:
```

## Short checklist

- Identify which phase fails: connect, write, read, or idle reuse.
- Capture packets and find which side sends `RST`.
- Compare app, proxy, and load balancer logs at the same timestamp.
- Check restarts, deploys, and one-node-only failures.
- Align keepalive and idle timeout values only after proving they are involved.

## References

- [Linux `tcp(7)` manual page](https://man7.org/linux/man-pages/man7/tcp.7.html)
- [Linux `tcpdump(8)` manual page](https://www.tcpdump.org/manpages/tcpdump.1.html)
- [Linux `ss(8)` manual page](https://man7.org/linux/man-pages/man8/ss.8.html)
- [Nginx upstream module documentation](https://nginx.org/en/docs/http/ngx_http_upstream_module.html)
