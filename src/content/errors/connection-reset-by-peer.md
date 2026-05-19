---
title: 'What does "connection reset by peer" mean?'
description: A practical guide to connection reset by peer that explains TCP resets, how to prove who sent the RST, and what to check in Linux, proxies, and upstream services.
slug: connection-reset-by-peer
publishedAt: 2026-05-13
updatedAt: 2026-05-19
tags:
  - TCP
  - Linux
  - sockets
related:
  - broken-pipe
  - connection-refused
  - tcp-retransmissions
  - upstream-prematurely-closed-connection
popular: true
---

`connection reset by peer` means the remote side, or something acting on behalf of it, abruptly reset the TCP connection. Instead of closing cleanly with `FIN`, the peer sent `RST`, so your process immediately loses the socket. In production, the reset may come from the application, a proxy, a load balancer, a firewall, or a server that restarted while the connection was active.

## What it means

At the TCP layer, a reset is an abrupt stop signal. The important detail is that `peer` does not always mean the final application server. It can also be:

- a reverse proxy;
- a load balancer;
- a service mesh sidecar;
- a firewall or NAT device;
- a kernel on the remote host.

Your first job is to prove where the reset came from.

## Common causes

- The upstream process crashed, restarted, or closed the socket under load.
- A proxy or load balancer closed an idle connection.
- Client and server disagreed about protocol behavior, such as sending HTTPS to an HTTP port.
- A firewall or middlebox reset the connection after an idle period or policy match.
- The server rejected malformed headers, oversized payloads, or invalid protocol framing.
- Keepalive reuse exposed a stale connection.

## Fast triage order

Use this order when you see the error in logs:

1. Confirm whether the reset happens during connect, request write, response read, or idle reuse.
2. Check whether it affects one host, one upstream instance, one endpoint, or all traffic.
3. Compare application logs on both sides at the same timestamp.
4. Capture packets around the failure and identify who sends `RST`.
5. Check proxy, load balancer, and keepalive timeout settings.
6. Inspect deploy, restart, OOM, and crash events near the first reset.

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

## How it differs from related errors

### `broken pipe`

Usually means your process tried to write after the other side had already closed or reset the connection.

### `connection refused`

Usually means the connection was rejected during connection setup because nothing was listening or the host actively refused it.

### `upstream prematurely closed connection`

This is Nginx's higher-level interpretation of an upstream closing earlier than expected. It may be caused by the same reset event.

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

## What not to assume

- Do not assume it is a random network problem.
- Do not assume the application server is always the peer.
- Do not fix it by only increasing timeouts.
- Do not ignore load balancers, service mesh, or keepalive reuse.

## Short checklist

- Identify which phase fails: connect, write, read, or idle reuse.
- Capture packets and find which side sends `RST`.
- Compare app, proxy, and load balancer logs at the same timestamp.
- Check restarts, deploys, and one-node-only failures.
- Align keepalive and idle timeout values only after proving they are involved.
