---
title: 'Why "connection refused" happens on Linux'
description: A practical guide to connection refused errors that separates missing listeners, bind address mistakes, wrong ports, container networking, and active firewall rejects.
slug: connection-refused
publishedAt: 2026-05-08
updatedAt: 2026-05-19
tags:
  - TCP
  - Linux
  - sockets
related:
  - connection-reset-by-peer
  - no-route-to-host
  - address-already-in-use
  - nginx-502-bad-gateway
---

`connection refused` means the TCP connection attempt reached a host that actively rejected it. In practice, the target port is usually not listening, the service is bound to the wrong address, the client is using the wrong port, or a firewall/proxy is configured to reject instead of silently drop traffic.

## What it means

This error is different from a timeout. With a timeout, the client waits and receives no useful response. With `connection refused`, the failure is immediate because something answered the connection attempt with a rejection.

That makes it easier to debug than many network errors.

## Common causes

- The service is not running.
- The service listens on `127.0.0.1` but the client connects to an external IP.
- The client is using the wrong host or port.
- A container exposes a port internally but not on the host.
- Kubernetes Service, Docker port mapping, or security group configuration is wrong.
- A firewall is actively rejecting the connection.

## Fast triage order

1. Check the exact host and port the client is using.
2. On the target host, confirm a process is listening on that IP and port.
3. Check whether the service is bound to `127.0.0.1`, `0.0.0.0`, or a specific interface.
4. If containers are involved, check port publishing and service DNS.
5. If the listener exists, inspect firewall or proxy reject rules.

## Commands to try

### Check listeners on the server

```bash
ss -ltnp
lsof -i :<port>
```

Look for both the port and the bind address.

Examples:

```text
127.0.0.1:8080    local-only listener
0.0.0.0:8080      all IPv4 interfaces
:::8080           IPv6/all interfaces depending on system config
```

### Check service state

```bash
systemctl status your-service
journalctl -u your-service --since -30m
```

### Test from the client and from the server

```bash
curl -v http://host:port/
nc -vz host port
curl -v http://127.0.0.1:port/
```

If local curl works but remote curl fails, suspect bind address, firewall, container mapping, or routing.

### Check firewall behavior

```bash
iptables -L -n
nft list ruleset
```

Reject rules often produce fast failures. Drop rules more often produce timeouts.

### In Docker

```bash
docker ps
docker port <container>
docker logs <container>
```

Verify that the container port is actually published to the host.

## How to separate it from similar errors

| Error | Meaning |
| --- | --- |
| `connection refused` | Host rejected the connection immediately |
| `connection timed out` | No response arrived before timeout |
| `no route to host` | Routing or host reachability failed |
| `connection reset by peer` | Connection existed, then peer reset it |

## How to fix it

### If the service is not running

- start or restart the service;
- inspect crash logs;
- check whether it failed to bind because the port is already used.

### If the bind address is wrong

- bind to the intended interface;
- use `0.0.0.0` only when the service should be reachable externally;
- keep admin-only services bound to localhost.

### If the port is wrong

- correct client config;
- check environment variables and service discovery;
- verify Nginx `proxy_pass` or upstream config.

### If containers are involved

- publish the port correctly;
- check container network mode;
- verify service names inside the same Docker network or Kubernetes namespace.

## Common mistakes

- Debugging DNS first even though the host already rejected the connection.
- Testing only on the server with `localhost`.
- Forgetting that `127.0.0.1` inside a container is not the host.
- Treating refusal and timeout as the same class of problem.

## Short checklist

- Confirm exact host and port.
- Check `ss -ltnp` on the target host.
- Compare local vs remote connection attempts.
- Inspect bind address before changing firewall rules.
- For containers, verify published ports and network scope.
