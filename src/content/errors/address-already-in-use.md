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

`address already in use` means a process tried to bind an IP and port that the kernel cannot currently assign to it. The most common cause is simple: another process is already listening. But in production, restart races, stale workers, systemd socket activation, containers, and socket reuse behavior can make the error less obvious.

## What it means

Binding a server socket claims a local address:

```text
IP address + port + protocol
```

If another listener already owns that combination, the new process cannot bind it.

## Common causes

- Another process is already listening on the port.
- A previous version of the service did not exit cleanly.
- Two instances start with the same default port.
- Docker or Kubernetes port mapping conflicts.
- systemd socket activation owns the socket.
- Restart loops create timing races.
- Socket reuse options are misunderstood.

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

### Inspect the process

```bash
ps -fp <pid>
readlink /proc/<pid>/exe
```

This helps identify stale workers or an unexpected binary.

### Check systemd

```bash
systemctl status your-service
systemctl list-sockets | grep '<port>'
```

If systemd socket activation owns the port, the service may not be the first process that binds it.

### Check containers

```bash
docker ps
docker port <container>
```

Host port conflicts and container-internal port conflicts are different problems.

## TIME_WAIT and reuse behavior

`TIME_WAIT` is often blamed incorrectly. A normal server listener usually should not fail to bind just because old client connections are in `TIME_WAIT`, especially when the server is binding a listening socket properly.

Investigate `SO_REUSEADDR` or `SO_REUSEPORT` only when:

- you understand the process model;
- active listeners are ruled out;
- rapid restart behavior is the real trigger;
- multiple workers intentionally share a port.

## How to fix it

### If another process owns the port

- stop the conflicting service;
- move one service to a different port;
- fix duplicate startup configuration.

### If a stale process remains

- fix graceful shutdown;
- ensure supervisors kill old workers correctly;
- avoid starting the new process before the old one releases the port.

### If containers conflict

- change host port mapping;
- verify service and container ports separately;
- check orchestration config for duplicate bindings.

### If systemd socket activation is involved

- understand whether systemd should own the socket;
- adjust service/socket units together;
- avoid double-binding the same port.

## What not to do

- Do not blindly kill processes without identifying ownership.
- Do not assume `TIME_WAIT` is the cause.
- Do not enable reuse options without understanding multiple-worker semantics.
- Do not confuse host ports with container ports.

## Short checklist

- Find the exact listener with `ss -ltnp`.
- Identify the owning process and supervisor.
- Check stale workers and duplicate instances.
- Inspect container or systemd socket ownership.
- Tune socket reuse only after proving it is relevant.
