---
title: 'How to debug "too many open files"'
description: A practical Linux file descriptor guide that separates low limits, descriptor leaks, burst traffic, socket accumulation, slow dependencies, and system-wide exhaustion.
slug: too-many-open-files
publishedAt: 2026-05-07
updatedAt: 2026-05-21
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

`too many open files` means an operation tried to open or allocate another file descriptor, but the relevant limit had already been reached. On Linux, a file descriptor is not only a regular file. TCP sockets, UDP sockets, pipes, directories, logs, deleted-but-still-open files, and runtime internals such as event notification or polling handles can all appear in a process descriptor table.

The useful question is not "what should I set `ulimit -n` to?" The useful question is:

```text
Which limit failed, what descriptor type consumed it, and is the growth valid load or a leak?
```

If you raise the limit before answering that question, you may turn a quick failure into a slower outage.

## A realistic incident shape

This is an example scenario, not a universal capacity model.

A backend service starts returning connection errors during a traffic spike. Logs show one or more of these messages:

```text
too many open files
EMFILE
accept4: Too many open files
dial tcp: socket: too many open files
open /var/log/app.log: too many open files
```

The first wrong move is to raise `ulimit -n` blindly. That may be correct eventually, but it does not tell you whether the service hit a legitimate concurrency limit, leaked descriptors, accumulated `CLOSE-WAIT` sockets, held deleted log files, or ran into host-wide file handle pressure.

The better first move is to identify the failing process and inspect its live descriptor state.

## What file descriptor exhaustion actually breaks

A descriptor shortage can surface far away from the true cause:

| Symptom | Why it can happen |
| --- | --- |
| new client connections fail | server cannot accept or create sockets |
| outbound calls fail | client cannot open a new socket to a dependency |
| DNS lookups fail | resolver path may need sockets or files |
| logging fails | process cannot open or rotate log files |
| health checks fail | the service cannot accept the check or call dependencies |
| deploy or restart fails | the new process cannot open files or bind sockets |

This is why the first visible error is not always the first resource that ran out.

## The limits involved

Linux file descriptor failures can involve several layers.

| Scope | Where to inspect | What it means |
| --- | --- | --- |
| process soft/hard limit | `/proc/<pid>/limits` | limit applied to the running process |
| shell session limit | `ulimit -n` | limit for the current shell and children |
| systemd service limit | `systemctl show <unit> -p LimitNOFILE` | service-manager limit for a unit |
| system-wide file handles | `/proc/sys/fs/file-nr` and `/proc/sys/fs/file-max` | kernel-wide file handle accounting |
| maximum per-process ceiling | `/proc/sys/fs/nr_open` | kernel ceiling for process file descriptors |

Do not assume `ulimit -n` in your terminal describes a service that systemd started earlier. Check the live process.

## First diagnostic commands

Start with the failing process ID:

```bash
pidof your-service
systemctl status your-service
```

Then inspect the live process limit:

```bash
cat /proc/<pid>/limits | grep -i files
```

Count descriptors:

```bash
ls /proc/<pid>/fd | wc -l
```

Classify what they are:

```bash
lsof -p <pid> | awk '{print $5}' | sort | uniq -c | sort -nr | head
```

If `lsof` is not available or is too slow on a busy host, a direct `/proc` view is often enough:

```bash
for fd in /proc/<pid>/fd/*; do
  readlink "$fd"
done | sort | uniq -c | sort -nr | head
```

These commands are observational. They do not fix the problem; they tell you which branch to investigate next.

## Watch the count over time

One snapshot cannot reliably separate a leak from valid concurrency.

```bash
while true; do
  date -Is
  ls /proc/<pid>/fd | wc -l
  sleep 5
done
```

Interpretation:

| Pattern | Strong suspect |
| --- | --- |
| count grows during idle or steady traffic and does not fall | descriptor leak or stuck cleanup |
| count rises with traffic and falls after traffic drops | valid concurrency, slow cleanup, or slow clients |
| count rises when a dependency slows down | outbound sockets held while waiting |
| count jumps during deploy or log rotation | duplicate process, log handling, or restart behavior |
| count is low but errors continue | wrong process, per-user/system limit, or short-lived spike missed by sampling |

Use measured process limits and descriptor counts from your own system. Do not copy limits from another service without checking traffic, fan-out, memory, and runtime behavior.

## Inspect socket states

Sockets are file descriptors. For backend services, socket accumulation is often the most important branch.

```bash
ss -tanp | grep '<pid-or-process-name>'
ss -s
```

Useful states:

| State | Meaning for this investigation |
| --- | --- |
| `ESTABLISHED` | active or stuck connections |
| `CLOSE-WAIT` | peer closed; local application has not closed its side yet |
| `SYN-SENT` | outbound connection attempts waiting or failing |
| `TIME-WAIT` | recently closed sockets; usually not descriptors held by the process |

Sustained `CLOSE-WAIT` growth is strong evidence that application cleanup is missing or delayed. Confirm by watching whether the count falls after traffic drops and by checking code paths that should close responses, sockets, streams, or files.

For outbound dependency pressure, check where sockets point:

```bash
ss -tanp | grep '<pid-or-process-name>' | awk '{print $1, $4, $5}' | sort | uniq -c | sort -nr | head
```

If many sockets point to one database, cache, queue, or HTTP dependency, the descriptor problem may be caused by downstream latency or an unbounded connection pool.

## Check system-wide file handle pressure

Linux kernel documentation describes `/proc/sys/fs/file-max` as the maximum number of file handles the kernel will allocate. It describes `/proc/sys/fs/file-nr` as three values: allocated file handles, allocated but unused file handles, and maximum file handles. On Linux 2.6 and later, the second value is reported as `0`.

Check:

```bash
cat /proc/sys/fs/file-nr
cat /proc/sys/fs/file-max
```

If the first value in `file-nr` is near the third value, investigate host-wide pressure. Also check kernel logs for file-handle exhaustion messages:

```bash
dmesg | grep -i 'file-max'
journalctl -k --since -1h | grep -i 'file-max'
```

Do not raise `file-max` as the first move. First identify which processes are consuming descriptors and whether the growth is expected.

## Deleted files can still consume descriptors

On Unix-like systems, deleting a file path does not necessarily close file descriptors that already point to that file. A process can keep writing to a deleted file until it closes the descriptor. This commonly appears after log rotation or temporary-file cleanup.

Check with `lsof`:

```bash
lsof -p <pid> | grep deleted
```

If large deleted files remain open:

- identify the owning process;
- signal or restart it so it reopens logs or closes files;
- fix log rotation configuration;
- avoid deleting active files that long-running processes still hold.

This is not the same as a normal descriptor leak, but it can consume descriptors and disk space.

## systemd limits: verify the live process

For services managed by systemd:

```bash
systemctl show your-service -p LimitNOFILE
cat /proc/<pid>/limits | grep -i files
```

If you need an override:

```bash
systemctl edit your-service
```

Example override:

```ini
[Service]
LimitNOFILE=65535
```

The value above is an example, not a recommended default. Choose a limit from measured concurrency, descriptor mix, runtime behavior, and memory budget.

Apply and verify:

```bash
systemctl daemon-reload
systemctl restart your-service
pidof your-service
cat /proc/<new-pid>/limits | grep -i files
```

systemd documents `LimitNOFILE=` as the service resource limit corresponding to `ulimit -n`. The same documentation warns that applications using `select(2)` cannot work with file descriptors above `1023` on Linux. Modern event loops usually avoid `select(2)`, but the warning is still a reason to verify your runtime and libraries instead of assuming every application is safe with very high descriptor numbers.

## Capacity sizing model

A safer descriptor budget starts with observed demand:

```text
inbound client sockets
+ outbound dependency sockets
+ files and logs
+ pipes/eventfds/epoll descriptors
+ runtime overhead
+ operational safety margin
```

This is a model, not a formula. The correct number depends on:

- maximum concurrent requests;
- keepalive behavior;
- number of downstream dependencies per request;
- connection pool limits;
- response streaming duration;
- slow-client behavior;
- retry behavior;
- memory available for sockets and buffers;
- runtime and library behavior.

If one request fans out to several dependencies and each dependency call can wait for a long time, descriptor usage can grow faster than request count. In that case, raising `LimitNOFILE` without pool limits and backpressure can make the service consume more resources before failing.

## Decision tree

```text
1. Identify the live process that logged the error.
2. Check /proc/<pid>/limits for open-file limits.
3. Count /proc/<pid>/fd.
4. Classify descriptor types with lsof or readlink.
5. If sockets dominate, inspect TCP states and remote endpoints.
6. If CLOSE-WAIT grows, inspect application cleanup paths.
7. If outbound sockets dominate, inspect dependency latency and pool limits.
8. If regular/deleted files dominate, inspect logging and file lifecycle.
9. If process usage is reasonable but host pressure is high, inspect file-nr and other processes.
10. Raise limits only after separating valid load from leaks.
```

## How to fix each major branch

### If the process limit is too low for measured valid load

- set `LimitNOFILE` or the appropriate service-manager limit;
- restart the service so the new process receives the new limit;
- verify the live process limit after restart;
- add descriptor usage monitoring;
- confirm memory and socket-buffer capacity.

### If descriptors leak

- identify the descriptor type that grows;
- find code paths that open but do not close;
- inspect exception and cancellation paths;
- close HTTP response bodies, streams, files, database cursors, and subprocess pipes;
- add tests or runtime metrics for resource lifetime.

### If `CLOSE-WAIT` grows

- the peer has closed, but the local process has not closed its side yet;
- inspect read loops and connection cleanup;
- make cancellation and close paths explicit;
- verify that counts fall after the fix under comparable traffic.

### If outbound sockets accumulate

- inspect dependency latency;
- enforce connection pool limits;
- add request deadlines;
- reduce fan-out;
- use backpressure instead of unlimited waits;
- make retries bounded by one total request deadline.

### If deleted files remain open

- identify the process holding deleted files;
- reopen logs by signal or restart where appropriate;
- fix log rotation to cooperate with the process;
- avoid deleting active files that are still open.

### If host-wide file handles are exhausted

- identify top descriptor-consuming processes;
- check whether growth is expected;
- inspect kernel logs;
- consider `file-max` only after proving host-wide demand is valid;
- avoid hiding a single-process leak by raising a global limit.

## What not to do

- Do not raise `ulimit -n` in your shell and assume a running systemd service changed.
- Do not raise `LimitNOFILE` before identifying descriptor type and growth pattern.
- Do not ignore sustained `CLOSE-WAIT`.
- Do not treat `TIME-WAIT` as a process descriptor leak without checking `/proc/<pid>/fd`.
- Do not set extremely high descriptor limits without memory, socket-buffer, and application-runtime planning.
- Do not remove deleted-but-open files from the investigation just because the path no longer exists.

## Incident note template

```text
service:
pid:
error message:
timestamp and timezone:
/proc/<pid>/limits open files:
fd count:
top descriptor types:
top remote socket endpoints:
TCP state summary:
CLOSE-WAIT count:
system file-nr:
system file-max:
recent deploy / log rotation / traffic spike:
dependency latency:
pool wait time:
change applied:
verification after change:
```

This separates measured facts from assumptions and makes the incident review useful later.

## Short checklist

- Check the live process, not only your shell.
- Count and classify descriptors before raising limits.
- Watch whether descriptor count grows forever or follows traffic.
- Treat sustained `CLOSE-WAIT` as strong cleanup evidence.
- Check system-wide `file-nr` only after process-level inspection.
- Size limits from measured concurrency, descriptor mix, and memory budget.
- Verify the new limit on the new process after restart.

## References

- [Linux kernel documentation: `/proc/sys/fs/file-max`, `file-nr`, and `nr_open`](https://docs.kernel.org/admin-guide/sysctl/fs.html)
- [systemd.exec documentation: `LimitNOFILE=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [lsof manual: listing open files and deleted path reporting](https://www.mankier.com/1/lsof)
