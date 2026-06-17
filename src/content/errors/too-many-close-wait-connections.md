---
title: 'How to debug too many CLOSE_WAIT connections'
description: A practical CLOSE_WAIT troubleshooting guide that separates peer close behavior, application cleanup bugs, leaked response bodies, slow workers, connection pools, and file descriptor pressure.
slug: too-many-close-wait-connections
publishedAt: 2026-06-17
updatedAt: 2026-06-17
tags:
  - TCP
  - Linux
  - sockets
related:
  - too-many-open-files
  - broken-pipe
  - socket-hang-up
  - connection-reset-by-peer
---

Many `CLOSE_WAIT` sockets mean the local process received a close from the peer, but the local application has not closed its side of the socket yet. A small number can be normal. A steadily growing count usually points to application cleanup, worker blockage, or connection lifecycle bugs.

The useful question is:

```text
Which local process owns the CLOSE_WAIT sockets, and why has it not closed them?
```

Do not tune TCP keepalive or kernel timeouts as the first move. `CLOSE_WAIT` is usually waiting on the application.

## Count and group sockets

Start with:

```bash
ss -tan state close-wait
ss -tanp state close-wait
```

Group by process:

```bash
ss -tanp state close-wait | awk -F'users:' '{print $2}' | sort | uniq -c | sort -nr | head
```

Check descriptor usage:

```bash
lsof -p <pid> | wc -l
cat /proc/<pid>/limits
```

If `CLOSE_WAIT` grows with file descriptor usage, `too many open files` may be the next visible error.

## What CLOSE_WAIT proves

It proves:

- the peer sent FIN or otherwise began a graceful close;
- the local kernel acknowledged it;
- the local process still owns the socket;
- the application has not closed the file descriptor.

It does not prove:

- the peer is broken;
- the network is dropping packets;
- the kernel is leaking sockets;
- TCP keepalive will solve it.

## Server-side branch

If the local process is a server:

Strong signals:

- clients disconnect after timeouts;
- handler continues work after client close;
- streaming/export routes dominate;
- worker threads are blocked;
- response body cleanup is delayed;
- `CLOSE_WAIT` increases during traffic spikes.

Checks:

```bash
ss -tanp state close-wait '( sport = :8080 )'
top -H -p <pid>
journalctl -u <service> --since -30m
```

Fix path:

- make request handlers cancellation-aware;
- stop expensive work after client disconnect when appropriate;
- close response streams in all error paths;
- avoid blocking worker threads;
- add deadlines to upstream calls.

## Client-side branch

If the local process is a client calling dependencies:

Strong signals:

- sockets point to one dependency;
- code does not close response bodies;
- connection pool is exhausted;
- retries create new connections but old ones remain;
- failures appear after dependency timeouts.

Checks:

```bash
ss -tanp state close-wait | grep '<remote-ip>'
ss -tanp '( dport = :443 )'
```

Common code patterns:

- HTTP response body not closed;
- exception path skips cleanup;
- stream reader exits early without closing;
- database cursor/connection not returned to pool;
- async task cancellation does not close socket.

Fix path:

- close response bodies in success and error paths;
- use `defer`/`finally` patterns where the language supports them;
- bound retries and request deadlines;
- inspect connection pool metrics.

## Distinguish CLOSE_WAIT from TIME_WAIT

| State | Owner of wait | Common meaning |
| --- | --- | --- |
| `CLOSE_WAIT` | local application | peer closed; local app has not closed |
| `TIME_WAIT` | TCP stack after active close | normal TCP cleanup after local side closed |

Many `TIME_WAIT` sockets often point to connection churn. Many `CLOSE_WAIT` sockets usually point to application lifecycle cleanup.

## Use timestamps and growth rate

Sample over time:

```bash
watch -n 5 'ss -tan state close-wait | wc -l'
```

Record:

- whether count rises without falling;
- which route or dependency changed;
- deployment time;
- traffic spike;
- timeout or 499/502 increase;
- file descriptor usage.

If the count drops after traffic drains, it may be slow cleanup. If it never drops until restart, suspect a leak or blocked cleanup path.

## What not to do

- Do not assume the kernel leaked sockets.
- Do not tune TCP keepalive first.
- Do not kill the process without preserving socket owner evidence.
- Do not confuse `CLOSE_WAIT` with `TIME_WAIT`.
- Do not ignore application error paths and cancellation behavior.

## Decision tree

```text
too many CLOSE_WAIT
|
+-- which process owns them?
|   +-- ss -tanp state close-wait
|
+-- local process is server?
|   +-- inspect client disconnects, streaming, handler cancellation
|
+-- local process is client?
|   +-- inspect response/body/connection cleanup and pool usage
|
+-- count grows with fd usage?
|   +-- inspect limits and leak paths
|
+-- count clears after traffic drains?
    +-- slow cleanup or blocked workers; still inspect lifecycle
```

## Minimal incident note

```text
process:
pid:
CLOSE_WAIT count:
remote addresses:
local ports:
fd count:
traffic route or dependency:
recent deploy:
thread/worker state:
cleanup path inspected:
fix:
verification:
```

The incident is solved when `CLOSE_WAIT` count stops growing under the same traffic pattern and sockets close without relying on process restarts.

## References

- [Linux `ss(8)` manual page](https://man7.org/linux/man-pages/man8/ss.8.html)
- [Linux `tcp(7)` manual page](https://man7.org/linux/man-pages/man7/tcp.7.html)
- [Linux `close(2)` manual page](https://man7.org/linux/man-pages/man2/close.2.html)
