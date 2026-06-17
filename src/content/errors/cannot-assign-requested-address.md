---
title: 'How to fix "cannot assign requested address"'
description: A practical cannot assign requested address guide that separates wrong bind IP, missing local address, container networking, source address selection, ephemeral port exhaustion, and TIME_WAIT pressure.
slug: cannot-assign-requested-address
publishedAt: 2026-06-17
updatedAt: 2026-06-17
tags:
  - Linux
  - TCP
  - sockets
related:
  - address-already-in-use
  - connection-refused
  - connect-timed-out
  - too-many-open-files
---

`cannot assign requested address` is often Linux `EADDRNOTAVAIL`. It means the process asked the kernel to use a local address or local socket tuple that is not available in the current network namespace.

The error appears in two broad situations:

- a server tries to bind to an IP address that is not present locally;
- a client creates many outbound connections and cannot allocate a usable local source address and port.

The useful question is:

```text
Was the process binding a listening socket, or opening outbound client connections?
```

Those branches have different fixes.

## Server bind branch

Common log examples:

```text
bind: Cannot assign requested address
listen tcp 10.0.2.15:8080: bind: cannot assign requested address
```

Check local addresses:

```bash
ip addr
ip route
ss -ltnp
```

If the service config says:

```text
bind_address = 10.0.2.15
```

but `ip addr` does not show `10.0.2.15` in that namespace, the bind cannot succeed.

Fix path:

- bind to an address that exists on the host/container/pod;
- use `0.0.0.0` only when the service should listen on all IPv4 interfaces;
- use `127.0.0.1` only for local-only services;
- update config after instance IP changes;
- verify inside the same container or network namespace as the service.

## Container and pod branch

Inside containers, `localhost` and interface addresses belong to the container namespace, not the host.

Checks:

```bash
docker exec -it <container> ip addr
docker exec -it <container> ss -ltnp
```

Kubernetes:

```bash
kubectl exec -it <pod> -- ip addr
kubectl exec -it <pod> -- ss -ltnp
```

Common mistakes:

- app tries to bind to the host private IP inside a container;
- app binds to a previous pod IP after restart;
- config injects a node IP but process runs in pod network;
- service should bind to `0.0.0.0` inside the pod, then expose through Service.

Do not copy host bind addresses into containers without checking the namespace.

## Client outbound branch

Client-side examples:

```text
connect: cannot assign requested address
java.net.BindException: Cannot assign requested address
```

This can happen when outbound connections churn faster than the local ephemeral port range can support, especially when many connections target the same remote IP and port.

Check connection state:

```bash
ss -tan state time-wait | wc -l
ss -tan '( dport = :443 )' | head
cat /proc/sys/net/ipv4/ip_local_port_range
```

Also check file descriptor pressure:

```bash
ulimit -n
cat /proc/<pid>/limits
lsof -p <pid> | wc -l
```

Strong signals:

- many short-lived outbound connections;
- large `TIME-WAIT` count;
- small ephemeral port range;
- no HTTP keepalive or connection pooling;
- client fans out to one remote IP:port;
- NAT gateway or node-level SNAT pressure.

## Source address selection

Some clients explicitly bind a source IP:

```text
local_address = 10.0.1.10
```

If that IP does not exist locally, outbound connect can fail before packets leave.

Check:

```bash
ip addr
ip route get <remote-ip>
```

`ip route get` shows which source IP the kernel would normally select. If an application overrides the source address, compare it with actual interface addresses.

## Fixes by evidence

### Wrong bind address

- replace stale instance IP with the current local IP;
- bind to `0.0.0.0` for externally reachable container services;
- bind admin endpoints to `127.0.0.1` only when local access is intended;
- verify with `ss -ltnp`.

### Ephemeral port exhaustion

- enable connection pooling or keepalive;
- reduce connection churn;
- increase client-side concurrency gradually only after measuring;
- widen ephemeral port range when appropriate;
- distribute connections across more destination IPs if the architecture supports it;
- inspect NAT/SNAT gateway limits in cloud environments.

### TIME_WAIT pressure

- confirm whether `TIME-WAIT` belongs to the client side;
- avoid rapid open/close loops;
- prefer pooled connections for HTTP, database, and RPC clients;
- do not blindly tune TCP sysctls without measuring the socket pattern.

### Container namespace mismatch

- bind inside the container to an address present inside the container;
- use Docker port publishing or Kubernetes Service to expose it;
- avoid host IP binds unless using host networking intentionally.

## What not to do

- Do not confuse this with `address already in use`.
- Do not assume the IP exists because it exists on the host.
- Do not fix client port exhaustion only by raising file descriptor limits.
- Do not disable connection reuse under high traffic.
- Do not change TCP sysctls before proving ephemeral port or TIME_WAIT pressure.

## Decision tree

```text
cannot assign requested address
|
+-- service is starting/listening?
|   +-- check bind IP exists in same namespace
|
+-- client is connecting outbound?
|   +-- check source IP, ephemeral ports, TIME_WAIT, connection pooling
|
+-- container or pod?
|   +-- check IPs inside container/pod, not host
|
+-- many short-lived connections?
    +-- inspect keepalive, port range, NAT/SNAT pressure
```

## Minimal incident note

```text
error:
server bind or client connect:
process namespace:
configured local address:
ip addr output:
ip route get output:
socket state counts:
ephemeral port range:
connection reuse setting:
container/pod network mode:
confirmed branch:
fix:
verification:
```

The incident is solved when the process uses a local address that exists in its namespace and outbound clients have enough reusable socket capacity for their connection pattern.

## References

- [Linux `bind(2)` manual page](https://man7.org/linux/man-pages/man2/bind.2.html)
- [Linux `connect(2)` manual page](https://man7.org/linux/man-pages/man2/connect.2.html)
- [Linux `ip(8)` manual page](https://man7.org/linux/man-pages/man8/ip.8.html)
- [Linux `tcp(7)` manual page](https://man7.org/linux/man-pages/man7/tcp.7.html)
