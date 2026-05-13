---
title: 'How to debug "too many open files"'
description: Understand file descriptor exhaustion in Linux services and learn how to separate leaks, burst load, and low limits.
slug: too-many-open-files
publishedAt: 2026-05-07
tags:
  - Linux
  - limits
  - services
related:
  - broken-pipe
  - io-timeout
---

`too many open files` means the process reached its file descriptor limit and can no longer open files, sockets, pipes, or similar resources. In backend systems, this often appears under burst traffic, connection leaks, or misconfigured limits.

## What it means

The kernel is refusing new descriptors because the process limit or system-wide limit has been exhausted. The symptom may show up as failed network accepts, failed file reads, or unstable application behavior under load.

## Common causes

- The process leaks sockets or files.
- The configured `ulimit` is too low for real traffic.
- Short-lived connections create descriptor churn faster than cleanup.
- A downstream dependency becomes slow and causes many descriptors to stay open longer.

## How to diagnose it

Do not raise the limit blindly. First check whether the application is leaking descriptors or just using them heavily.

1. Check the current per-process limit.
2. Count open descriptors for the target process.
3. Compare normal steady-state counts with spike counts.
4. Inspect whether a specific file type or socket state is growing continuously.

## Commands to try

```bash
ulimit -n
cat /proc/<pid>/limits
lsof -p <pid> | wc -l
lsof -p <pid> | head -50
```

## How to fix it

If the application leaks descriptors, fix the code path first. If the workload is legitimate, raise the limits carefully and monitor descriptor usage during peak traffic. Also inspect slow dependencies that keep connections open longer than expected.

## FAQ

### Can increasing ulimit solve it?

Sometimes, but only if the workload is valid. If you have a leak, raising the limit just delays the next failure.

### Does this affect sockets and files the same way?

Yes. They all consume file descriptors from the same process limit.

## Short checklist

- Measure descriptor count before changing limits
- Check for continuous growth
- Separate burst load from real leaks
