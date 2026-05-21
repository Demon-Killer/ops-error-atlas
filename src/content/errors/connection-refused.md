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

The useful property of this error is that the path usually reached something that could reject the connection. That "something" may be the target host kernel, a firewall, a proxy, a container boundary, or a load balancer. The next step is to prove which layer rejected the SYN.

## Common causes

- The service is not running.
- The service listens on `127.0.0.1` but the client connects to an external IP.
- The client is using the wrong host or port.
- A container exposes a port internally but not on the host.
- Kubernetes Service, Docker port mapping, or security group configuration is wrong.
- A firewall is actively rejecting the connection.

## First prove the connection target

Write down the exact tuple:

```text
client source:
destination hostname:
resolved destination IP:
destination port:
protocol: tcp
namespace: host, container, pod, or proxy
```

Refused connections are frequently caused by one wrong assumption: the client is not connecting to the host, port, or network namespace that the operator is checking.

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

Also test the concrete IP that DNS returned:

```bash
getent hosts host
nc -vz <resolved-ip> <port>
```

If DNS returns multiple IPs, test each one. One bad backend behind a service record can create intermittent `connection refused` even when most requests work.

### Check firewall behavior

```bash
iptables -L -n
nft list ruleset
```

Reject rules tend to produce fast failures. Drop rules tend to produce timeouts because the client receives no explicit response.

If you see `REJECT --reject-with tcp-reset`, the firewall can intentionally make a blocked port look like a real refusal from the host.

### In Docker

```bash
docker ps
docker port <container>
docker logs <container>
```

Verify that the container port is actually published to the host.

Remember the namespace boundary:

```text
127.0.0.1 inside container != 127.0.0.1 on host
```

If the service binds only to localhost inside the container, it may be reachable from inside the container but not from another container or the host-published path.

### In Kubernetes

```bash
kubectl get svc,endpoints,pod -o wide
kubectl describe svc <service>
kubectl exec -it <pod> -- nc -vz <service-name> <port>
```

Check whether the Service has endpoints. A Service with no ready endpoints may send traffic nowhere, while a pod listening on the wrong port can still look healthy from a shallow readiness check.

## How to separate it from similar errors

| Error | Meaning |
| --- | --- |
| `connection refused` | Host rejected the connection immediately |
| `connection timed out` | No response arrived before timeout |
| `no route to host` | Routing or host reachability failed |
| `connection reset by peer` | Connection existed, then peer reset it |

## Decision table

| Evidence | Likely cause | Next check |
| --- | --- | --- |
| no listener in `ss -ltnp` | service not running or wrong port | service logs and startup config |
| listener on `127.0.0.1` only | bind address too narrow | bind config and exposure requirements |
| local works, remote refused | firewall, bind address, or port publishing | remote test and firewall rules |
| one DNS IP refused | bad target behind DNS/load balancer | remove or fix that target |
| container local works, host fails | Docker port publishing or namespace issue | `docker port` and bind address |
| Kubernetes Service has no endpoints | selector/readiness issue | pod labels, readiness, targetPort |

## How to fix it

### If the service is not running

- start or restart the service;
- inspect crash logs;
- check whether it failed to bind because the port is already used.

Do not stop at "service active." A supervisor can report active while the application failed to bind the expected port. Confirm with `ss -ltnp`.

### If the bind address is wrong

- bind to the intended interface;
- use `0.0.0.0` only when the service should be reachable externally;
- keep admin-only services bound to localhost.

For IPv6, verify whether the service listens on `::`, `::1`, or IPv4 addresses. Dual-stack behavior differs by runtime and OS configuration.

### If the port is wrong

- correct client config;
- check environment variables and service discovery;
- verify Nginx `proxy_pass` or upstream config.

### If containers are involved

- publish the port correctly;
- check container network mode;
- verify service names inside the same Docker network or Kubernetes namespace.

For Kubernetes, verify `port`, `targetPort`, pod readiness, and NetworkPolicy. A wrong `targetPort` is a common cause of a Service that exists but cannot reach the container listener.

### If a firewall rejects the connection

- confirm the rule is intentional;
- allow only the required source CIDR, destination port, and protocol;
- prefer a specific allow rule over disabling the firewall;
- document whether blocked clients should see reject or timeout behavior.

## Common mistakes

- Debugging DNS first even though the host already rejected the connection.
- Testing only on the server with `localhost`.
- Forgetting that `127.0.0.1` inside a container is not the host.
- Treating refusal and timeout as the same class of problem.
- Declaring the service healthy without checking the actual listening socket.
- Testing only one IP when the hostname resolves to multiple targets.

## Short checklist

- Confirm exact host and port.
- Check `ss -ltnp` on the target host.
- Compare local vs remote connection attempts.
- Inspect bind address before changing firewall rules.
- For containers, verify published ports and network scope.
- Test each resolved IP when failures are intermittent.
