---
title: 'How to fix "address already in use"'
description: A practical Linux bind conflict guide that separates active listeners, stale processes, restart races, TIME_WAIT confusion, SO_REUSEADDR, containers, and systemd socket activation.
slug: address-already-in-use
publishedAt: 2026-05-01
updatedAt: 2026-05-20
tags:
  - Linux
  - sockets
  - services
related:
  - connection-refused
  - too-many-open-files
  - broken-pipe
  - socket-hang-up
---

`address already in use` means a process tried to bind an IP and port that the kernel cannot currently assign to it. A common first suspect is simple: another process may already be listening. But in production, restart races, stale workers, systemd socket activation, containers, and socket reuse behavior can make the error less obvious.

## What it means

Binding a server socket claims a local address:

```text
IP address + port + protocol
```

If another listener already owns that combination, the new process cannot bind it.

The details matter:

- `0.0.0.0:8080` usually conflicts with `127.0.0.1:8080` because it listens on all IPv4 addresses.
- `:::8080` may also cover IPv4 depending on the `ipv6only` setting.
- TCP and UDP are separate protocols, so a TCP listener does not automatically conflict with UDP on the same port.
- A host port and a container-internal port are not the same thing.

Many bad fixes happen because the exact bind address is not identified before killing processes or changing ports.

## Common causes

- Another process is already listening on the port.
- A previous version of the service did not exit cleanly.
- Two instances start with the same default port.
- Docker or Kubernetes port mapping conflicts.
- systemd socket activation owns the socket.
- Restart loops create timing races.
- Socket reuse options are misunderstood.

## First identify the bind scope

Before changing anything, write down:

```text
protocol: tcp or udp
address: 127.0.0.1, 0.0.0.0, ::1, ::, or a specific private IP
port: the numeric port
namespace: host, container, pod, or systemd socket
```

This avoids a common mistake: seeing a process on `127.0.0.1:8080` and assuming it explains a conflict for `10.0.1.12:8080`, or seeing a container expose `8080/tcp` and assuming the host port is also `8080`.

## Fast triage order

1. Identify the exact IP and port the service wants.
2. Check who is listening on that port.
3. Check whether the old service process still exists.
4. Check supervisor behavior: systemd, Docker, Kubernetes, PM2, etc.
5. Investigate socket reuse only after active listeners are ruled out.

## Commands to try

### Find the listener

```bash
ss -ltnp | grep ':<port>'
lsof -i :<port>
```

Check both address and process. `127.0.0.1:8080` and `0.0.0.0:8080` do not have the same exposure.

For UDP listeners:

```bash
ss -lunp | grep ':<port>'
```

For IPv6 behavior:

```bash
sysctl net.ipv6.bindv6only
ss -ltnp '( sport = :<port> )'
```

### Inspect the process

```bash
ps -fp <pid>
readlink /proc/<pid>/exe
```

This helps identify stale workers or an unexpected binary.

Also check the working directory and command line:

```bash
tr '\0' ' ' < /proc/<pid>/cmdline
readlink /proc/<pid>/cwd
```

Those two often reveal whether the process is the old release, a local dev server, or a supervisor-managed worker.

### Check systemd

```bash
systemctl status your-service
systemctl list-sockets | grep '<port>'
```

If systemd socket activation owns the port, the service may not be the first process that binds it.

When socket activation is enabled, the `.socket` unit owns the listening socket and passes it to the `.service` unit. Starting a service that also tries to bind the same port manually can create a double-bind conflict.

### Check containers

```bash
docker ps
docker port <container>
```

Host port conflicts and container-internal port conflicts are different problems.

For Kubernetes, check whether the conflict is inside the pod or at the node port layer:

```bash
kubectl get pod -o wide
kubectl describe pod <pod>
kubectl get svc
```

## TIME_WAIT and reuse behavior

`TIME_WAIT` is often blamed incorrectly. A normal server listener should not be assumed to fail just because old client connections are in `TIME_WAIT`; first verify whether another listener, socket activation, or a process-model issue owns the address.

Investigate `SO_REUSEADDR` or `SO_REUSEPORT` only when:

- you understand the process model;
- active listeners are ruled out;
- rapid restart behavior is the real trigger;
- multiple workers intentionally share a port.

`SO_REUSEADDR` and `SO_REUSEPORT` are not magic "fix address already in use" switches. They change how the kernel allows binds and distributes traffic. Used incorrectly, they can hide duplicate instances or split traffic between incompatible processes.

## Decision table

| Evidence | Likely cause | Safer fix |
| --- | --- | --- |
| `ss -ltnp` shows another process | active listener | stop or reconfigure the owner |
| same service has two PIDs | stale worker or duplicate start | fix supervisor lifecycle |
| only container start fails | host port mapping conflict | change host mapping or stop conflicting container |
| `systemctl list-sockets` owns the port | socket activation | align `.socket` and `.service` units |
| no listener, rapid restart only | reuse/restart race | inspect shutdown, worker model, and socket options |

## How to fix it

### If another process owns the port

- stop the conflicting service;
- move one service to a different port;
- fix duplicate startup configuration.

### If a stale process remains

- fix graceful shutdown;
- ensure supervisors kill old workers correctly;
- avoid starting the new process before the old one releases the port.

For zero-downtime deploys, prefer a process manager or load balancer that drains old workers before new workers bind. Hand-written restart scripts often create a window where both generations try to own the same port.

### If containers conflict

- change host port mapping;
- verify service and container ports separately;
- check orchestration config for duplicate bindings.

### If systemd socket activation is involved

- understand whether systemd should own the socket;
- adjust service/socket units together;
- avoid double-binding the same port.

If the service is designed for socket activation, it should accept the inherited file descriptor instead of calling `bind()` on the same address. If it is not designed for socket activation, disable the socket unit and let the service bind normally.

## Safe operational workflow

1. Identify the listener and owner.
2. Confirm whether it is expected.
3. Stop it through its supervisor, not with a blind `kill -9`.
4. Start the desired service.
5. Verify the listener address and protocol.

Use `kill -9` only as a last resort after you know which process owns the socket and why normal shutdown failed.

## What not to do

- Do not blindly kill processes without identifying ownership.
- Do not assume `TIME_WAIT` is the cause.
- Do not enable reuse options without understanding multiple-worker semantics.
- Do not confuse host ports with container ports.
- Do not change the application port before checking whether a supervisor starts duplicate instances.

## Short checklist

- Find the exact listener with `ss -ltnp`.
- Identify the owning process and supervisor.
- Check stale workers and duplicate instances.
- Inspect container or systemd socket ownership.
- Tune socket reuse only after proving it is relevant.
- Verify the final bind address, not just that the process started.
