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

File descriptor exhaustion is dangerous because it creates secondary failures. A service may fail to accept new clients, fail to open logs, fail DNS lookups, fail outbound database connections, or fail health checks. The first visible error may not be the first resource that ran out.

## Common causes

- Socket or file descriptor leak.
- Very low `ulimit -n` or systemd `LimitNOFILE`.
- Burst traffic creates more concurrent sockets than expected.
- Slow clients or downstream dependencies keep connections open.
- Missing connection pooling limits.
- System-wide file descriptor pressure.

## Know which limit failed

Linux has multiple relevant limits:

| Scope | Where to check | Why it matters |
| --- | --- | --- |
| process soft/hard limit | `/proc/<pid>/limits` | most common service failure |
| systemd service limit | `systemctl show ... -p LimitNOFILE` | shell `ulimit` may not apply |
| user/session limit | PAM or shell limits | affects manually started processes |
| system-wide file table | `/proc/sys/fs/file-nr` | affects the whole host |

Raising the wrong limit is a common reason the issue appears "fixed" in a shell but not in production.

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

For a systemd override:

```bash
systemctl edit your-service
systemctl daemon-reload
systemctl restart your-service
```

Then re-check `/proc/<pid>/limits` on the new process. Do not assume the override applied.

### Count open descriptors

```bash
ls /proc/<pid>/fd | wc -l
lsof -p <pid> | wc -l
```

Watch the count over time:

```bash
while true; do
  date -Is
  ls /proc/<pid>/fd | wc -l
  sleep 5
done
```

A count that grows steadily during idle traffic suggests a leak. A count that rises and falls with traffic suggests legitimate concurrency or slow cleanup.

### Classify descriptors

```bash
lsof -p <pid> | awk '{print $5}' | sort | uniq -c | sort -nr | head
lsof -p <pid> | head -50
```

A faster low-level view:

```bash
for fd in /proc/<pid>/fd/*; do readlink "$fd"; done | sort | uniq -c | sort -nr | head
```

This can reveal repeated sockets, deleted files, pipes, eventfds, or log files.

### Inspect socket states

```bash
ss -tanp | grep '<pid-or-process-name>'
ss -s
```

If many sockets are stuck in established or close-wait states, inspect application close behavior and downstream latency.

Useful socket-state clues:

| State | Interpretation |
| --- | --- |
| `ESTABLISHED` | active or stuck connections |
| `CLOSE-WAIT` | peer closed; application has not closed its side |
| `SYN-SENT` | outbound connects waiting or failing |
| `TIME-WAIT` | recently closed sockets, usually not a descriptor held by the process |

`CLOSE-WAIT` growth is almost always an application cleanup problem.

### Check system-wide usage

```bash
cat /proc/sys/fs/file-nr
cat /proc/sys/fs/file-max
```

`file-nr` has three fields: allocated file handles, unused allocated handles, and maximum file handles. Compare the first and third fields for system pressure.

## How to separate major cases

| Signal | Likely cause |
| --- | --- |
| descriptor count grows forever | leak |
| count spikes with traffic then returns | legitimate concurrency or burst load |
| many `CLOSE-WAIT` sockets | app not closing after peer close |
| many outbound connections | pool limit or dependency slowness |
| system-wide file-nr near max | host-level pressure |
| many deleted files open | logs/temp files rotated but still held |
| fd count high after traffic drops | leak or stuck cleanup |
| fd count proportional to in-flight work | legitimate capacity sizing |

## Capacity sizing rule of thumb

Estimate descriptor demand before choosing a limit:

```text
inbound connections
+ outbound dependency connections
+ files and logs
+ pipes/eventfds/epoll descriptors
+ safety margin
```

If one request fans out to several downstream services and keeps sockets open while waiting, descriptor usage can grow faster than request count. Set connection pool limits and backpressure so the service fails predictably instead of exhausting descriptors.

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

After changing limits, verify with the live PID:

```bash
pidof your-service
cat /proc/<pid>/limits | grep -i files
```

### If the application leaks descriptors

- find which descriptor type grows;
- add missing `close()` or cleanup paths;
- fix error paths that skip cleanup;
- add tests or metrics around resource lifetime.

Leak-prone paths include exceptions after opening a file, HTTP clients without response body close, database cursors, file watchers, subprocess pipes, and log rotation with descriptors held open.

### If slow dependencies hold sockets open

- set outbound pool limits;
- set dependency timeouts;
- reduce fan-out;
- add backpressure instead of allowing unbounded waits.

This is not a classic leak: descriptors may eventually close, but too slowly for the current traffic. The fix is usually pool limits, shorter dependency deadlines, queue limits, and fewer concurrent fan-outs.

### If close-wait grows

- the peer has closed, but your process has not closed its side;
- inspect read loops and connection cleanup;
- fix application lifecycle handling.

For HTTP clients, make sure response bodies are fully consumed or explicitly closed. For servers, make sure aborted client connections trigger cleanup of streaming work.

### If deleted files consume descriptors

- identify deleted-but-open files with `lsof`;
- restart or signal the owner to reopen logs;
- fix log rotation configuration;
- avoid writing large temporary files that remain open after deletion.

## What not to do

- Do not only raise `ulimit` if the descriptor count grows without bound.
- Do not ignore `CLOSE-WAIT`.
- Do not forget systemd limits when shell `ulimit` looks correct.
- Do not treat sockets and files as separate budgets; both consume descriptors.
- Do not set extremely high limits without connection pool and memory planning.

## Short checklist

- Check `/proc/<pid>/limits`.
- Count and classify open descriptors.
- Watch whether usage grows forever or spikes with load.
- Inspect socket states, especially `CLOSE-WAIT`.
- Raise limits only after separating valid load from leaks.
- Verify the new limit on the live process after restart.
