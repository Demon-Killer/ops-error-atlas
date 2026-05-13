---
title: 'How to fix "address already in use"'
description: Understand port binding conflicts on Linux and learn how to identify the process or restart pattern that keeps the port occupied.
slug: address-already-in-use
publishedAt: 2026-05-01
tags:
  - Linux
  - sockets
  - services
related:
  - connection-refused
  - broken-pipe
---

`address already in use` means your process tried to bind a socket that is already occupied or not yet reusable under the current restart pattern. This usually shows up when another service is already listening or when rapid restarts expose socket reuse issues.

## What it means

The operating system rejected the bind request because the IP and port combination is not currently available under the requested conditions.

## Common causes

- Another process is already listening on the same port.
- The old process did not exit cleanly.
- Rapid restarts expose `TIME_WAIT` and reuse behavior.
- Multiple instances use the same default port unexpectedly.

## How to diagnose it

The first question is simple: who owns the port right now?

1. Check for listeners on the target port.
2. Confirm whether an old process is still alive.
3. Review restart loops or duplicate service instances.
4. Inspect socket reuse settings only after confirming the basics.

## Commands to try

```bash
ss -ltnp
lsof -i :<port>
ps -fp <pid>
systemctl status your-service
```

## How to fix it

Stop the conflicting process, change the port, or fix the restart behavior that leaves an old process in place. Only tune socket reuse options when you understand the lifecycle of the service.

## FAQ

### Does TIME_WAIT always cause this error?

No. The most common cause is still another listener or an old process that never exited.

### Should I just enable address reuse?

Not by default. First confirm whether the process model is correct.

## Short checklist

- Identify who owns the port
- Check for stale processes
- Fix restart behavior before socket tuning
