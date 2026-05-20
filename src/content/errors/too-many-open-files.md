---
title: 'How to debug "too many open files"'
description: A practical Linux file descriptor guide that separates low limits, descriptor leaks, burst traffic, socket accumulation, slow dependencies, and system-wide exhaustion.
slug: too-many-open-files
publishedAt: 2026-05-07
updatedAt: 2026-05-20
tags:
  - Linux
  - limits
  - services
related:
  - broken-pipe
  - io-timeout
  - socket-hang-up
  - connection-refused
---

`too many open files` means a process, user, or system has exhausted its file descriptor budget. On Linux, sockets, files, pipes, eventfds, epoll descriptors, and many other resources consume file descriptors. In backend services, the symptom often appears as failed accepts, failed outbound connections, log write failures, or unstable behavior under load.

## What it means

Every process has a limit on how many file descriptors it can keep open. When the limit is reached, new operations fail even if CPU and memory look fine.

The cause is usually one of three things:

- the limit is too low for legitimate traffic;
- the application leaks descriptors;
- a slow dependency keeps sockets open longer than expected.

## Common causes

- Socket or file descriptor leak.
- Very low `ulimit -n` or systemd `LimitNOFILE`.
- Burst traffic creates more concurrent sockets than expected.
- Slow clients or downstream dependencies keep connections open.
- Missing connection pooling limits.
- System-wide file descriptor pressure.

## Fast triage order

1. Identify the failing process.
2. Check per-process limits.
3. Count descriptors currently open.
4. Classify descriptor types: TCP sockets, files, pipes, anon_inode, etc.
5. Watch whether the count grows continuously or only spikes under load.
6. Check system-wide file descriptor usage.

## Commands to try

### Check process limits

```bash
cat /proc/<pid>/limits | grep -i files
ulimit -n
```

For systemd services:

```bash
systemctl show your-service -p LimitNOFILE
```

### Count open descriptors

```bash
ls /proc/<pid>/fd | wc -l
lsof -p <pid> | wc -l
```

### Classify descriptors

```bash
lsof -p <pid> | awk '{print $5}' | sort | uniq -c | sort -nr | head
lsof -p <pid> | head -50
```

### Inspect socket states

```bash
ss -tanp | grep '<pid-or-process-name>'
ss -s
```

If many sockets are stuck in established or close-wait states, inspect application close behavior and downstream latency.

### Check system-wide usage

```bash
cat /proc/sys/fs/file-nr
cat /proc/sys/fs/file-max
```

## How to separate major cases

| Signal | Likely cause |
| --- | --- |
| descriptor count grows forever | leak |
| count spikes with traffic then returns | legitimate concurrency or burst load |
| many `CLOSE-WAIT` sockets | app not closing after peer close |
| many outbound connections | pool limit or dependency slowness |
| system-wide file-nr near max | host-level pressure |

## How to fix it

### If the limit is too low

- raise per-service `LimitNOFILE`;
- set appropriate user limits;
- reload systemd and restart the service;
- monitor descriptor usage after the change.

Example systemd override:

```ini
[Service]
LimitNOFILE=65535
```

### If the application leaks descriptors

- find which descriptor type grows;
- add missing `close()` or cleanup paths;
- fix error paths that skip cleanup;
- add tests or metrics around resource lifetime.

### If slow dependencies hold sockets open

- set outbound pool limits;
- set dependency timeouts;
- reduce fan-out;
- add backpressure instead of allowing unbounded waits.

### If close-wait grows

- the peer has closed, but your process has not closed its side;
- inspect read loops and connection cleanup;
- fix application lifecycle handling.

## What not to do

- Do not only raise `ulimit` if the descriptor count grows without bound.
- Do not ignore `CLOSE-WAIT`.
- Do not forget systemd limits when shell `ulimit` looks correct.
- Do not treat sockets and files as separate budgets; both consume descriptors.

## Short checklist

- Check `/proc/<pid>/limits`.
- Count and classify open descriptors.
- Watch whether usage grows forever or spikes with load.
- Inspect socket states, especially `CLOSE-WAIT`.
- Raise limits only after separating valid load from leaks.
