---
title: 'How to fix "broken pipe" in Linux applications'
description: A practical guide to broken pipe errors in Linux services, focused on finding who closed first, which write path failed, and how proxies, clients, and streaming responses trigger it.
slug: broken-pipe
publishedAt: 2026-05-12
updatedAt: 2026-05-26
tags:
  - Linux
  - sockets
  - services
related:
  - connection-reset-by-peer
  - connection-refused
  - upstream-prematurely-closed-connection
  - socket-hang-up
---

`broken pipe` means your process tried to write to a pipe or socket after the other side could no longer receive that write. In Linux and POSIX terminology, the write path commonly surfaces as `EPIPE`; depending on the API and signal handling, the process may also receive `SIGPIPE`.

The useful question is not "how do I suppress broken pipe?" The useful question is:

```text
Who closed first, what was the process still writing, and should that work have been canceled earlier?
```

For backend services, `broken pipe` is often a late symptom. The client, proxy, load balancer, or upstream peer may have closed earlier. Your application discovers the problem only when it tries to write again.

## The system-call fact

The Linux `write(2)` and POSIX `write()` documentation describe `EPIPE` for writes to a pipe or socket whose reading end is closed. The Linux pipe documentation also describes the related behavior: if all file descriptors for the read end of a pipe are closed, a write causes `SIGPIPE`; if that signal is ignored, the write fails with `EPIPE`.

For sockets, `send(2)` documents `MSG_NOSIGNAL`, which prevents `SIGPIPE` from being generated on stream-oriented sockets while still returning `EPIPE` as an error. This is why different runtimes show the same underlying failure differently:

- C/C++ may see `SIGPIPE`, `EPIPE`, or both depending on signal handling and API flags;
- Go often logs `write: broken pipe`;
- Python may raise `BrokenPipeError`;
- Java may surface a socket write exception;
- Node.js may report related socket close errors such as `socket hang up` depending on phase.

Those language examples are illustrative. Always check the actual runtime error and the write phase.

## A realistic incident shape

This is an example scenario, not a claim about all incidents.

An API endpoint streams a report. Users start canceling downloads or a load balancer reaches its timeout. The application keeps generating rows and writing chunks. Later it logs:

```text
write: broken pipe
```

The weak conclusion is:

```text
The server crashed or the network is broken.
```

The better investigation asks:

```text
Did the downstream client close first?
Was the response too slow or too large?
Did a proxy log 499?
Did the application continue expensive work after cancellation?
Did the peer send FIN or RST?
```

## Broken pipe is a write-path error

Classify what your process was writing:

| Write path | Common owner to inspect |
| --- | --- |
| response headers | client/proxy closed before response started |
| small JSON body | upstream latency, client timeout, handler delay |
| large download | slow client, response size, buffering, timeout |
| streaming chunks | idle gaps, cancellation handling, proxy read/write timeouts |
| request body to upstream | upstream closed while proxy/client was still sending |
| log or file output | local file/pipe lifecycle, not necessarily network |

Do not debug all broken pipes as one problem. The write path determines the likely owner.

## Build a close-order timeline

For a real incident, reconstruct the order:

```text
request accepted
request body read
upstream or dependency work started
response headers attempted
response body write attempted
client/proxy close observed
application work canceled or continued
broken pipe logged
```

The final `broken pipe` stack trace is rarely the first cause. It is often the first write after the other side has already gone away.

## First diagnostic commands

Start with logs:

```bash
journalctl -u your-service --since -30m
journalctl -u nginx --since -30m
tail -200 /var/log/nginx/access.log
tail -200 /var/log/nginx/error.log
```

If Nginx is in front of the service, compare application `broken pipe` timestamps with Nginx `499`, `$request_time`, `$upstream_response_time`, and request IDs.

Inspect sockets:

```bash
ss -tanp
ss -tan state established
```

Look for send queues that do not drain:

```bash
ss -tanp | awk '$2 != "0" || $3 != "0" {print}'
```

Large send queues can indicate a slow downstream receiver, a blocked path, or an application producing data faster than the peer can consume it.

Capture close behavior:

```bash
tcpdump -tttt -nn -i any host <peer-ip> and port <port>
```

Use packet capture to answer a narrow question: which side sent `FIN` or `RST` first? It does not by itself explain why that side closed.

## FIN, RST, and why the next write fails

At the TCP level:

| Signal | Practical meaning |
| --- | --- |
| `FIN` | orderly close path; one side says it has finished sending |
| `RST` | abortive reset path; one side tears the connection down |

Either can lead to a later broken pipe if the application writes after the peer is gone. `RST` often makes the failure more abrupt. `FIN` can still lead to a failed write if the application ignores the close and continues writing.

Do not infer the application root cause from `FIN` or `RST` alone. Use it to establish close order, then inspect logs and timeouts.

## How to interpret common patterns

| Evidence | Strong suspect | What to verify |
| --- | --- | --- |
| Nginx logs `499` at same time | downstream closed before response completed | request time, upstream time, client/proxy timeout |
| large responses fail more than small ones | slow client, buffering, download size, idle timeout | bytes sent, response size, streaming gaps |
| errors cluster after a fixed duration | timeout boundary | client, load balancer, proxy, application deadline |
| app continues DB/API work after close | missing cancellation propagation | request context, abort signal, downstream call cancellation |
| peer sends `RST` before app write | peer or middlebox reset | packet capture, proxy logs, client logs |
| spike during deploy | draining or shutdown problem | readiness removal, load balancer drain, worker shutdown |
| errors are rare and random | normal client aborts may be acceptable | baseline rate and user impact |

Every row is a hypothesis. Confirm with request IDs, timestamps, and phase evidence.

## Cancellation is the real fix in many services

If the caller is gone, continuing expensive work may waste capacity.

Good services make cancellation visible:

```text
client disconnected
request context canceled
downstream DB/API call canceled
streaming loop stopped
response writer stopped
cleanup completed
```

Check whether your runtime exposes request cancellation:

- HTTP server request context;
- abort signal;
- connection close callback;
- stream write error;
- proxy/client disconnect log;
- downstream call deadline.

The exact API depends on language and framework. The design goal is the same: stop work that can no longer produce a useful response.

## Streaming and long responses

Streaming endpoints need special care. A stream may be healthy, but if it sends no bytes longer than a proxy or client idle timeout, the downstream side can close.

Check:

- how often chunks are written;
- whether writes are flushed intentionally;
- whether proxy buffering is enabled;
- whether the client or load balancer has an idle timeout;
- whether large exports should be async jobs instead of one long response;
- whether partial downloads can resume.

Do not fix every streaming broken pipe by raising timeouts. Sometimes the better design is pagination, background export, resumable transfer, or explicit progress polling.

## Proxy and load balancer timeouts

Compare timeout budgets:

```text
client timeout
front load balancer timeout
Nginx proxy read/send timeout
upstream app deadline
database/API dependency deadline
```

This is a diagnostic model, not a universal formula. The key question is whether an outer layer gives up while the inner application keeps doing expensive work.

For Nginx, inspect:

```bash
nginx -T | grep -E 'proxy_read_timeout|proxy_send_timeout|send_timeout|keepalive|proxy_buffering'
```

Also inspect timeouts outside Nginx: cloud load balancers, API gateways, service meshes, browser/client libraries, and upstream dependency clients.

## Fixes by evidence

### If the client or proxy closed first

- decide whether the abort is normal user behavior or a systematic issue;
- stop expensive application work after disconnect;
- reduce noisy stack traces for expected aborts;
- investigate spikes and endpoint concentration.

### If upstream latency caused the downstream to give up

- profile the slow handler;
- log dependency timings;
- reduce DB/cache/API latency;
- add request deadlines;
- return partial, async, or paginated responses when appropriate.

### If large responses trigger broken pipes

- reduce payload size;
- paginate;
- use resumable downloads;
- move long exports to background jobs;
- make streaming writes cancellation-aware.

### If deploys trigger broken pipes

- remove instances from rotation before shutdown;
- let in-flight requests drain;
- align load balancer drain time with application shutdown behavior;
- avoid killing workers still writing responses.

### If the code ignores write errors

- check every write result;
- exit streaming loops on write failure;
- propagate cancellation to downstream calls;
- avoid retrying writes to the same closed connection.

## What not to do

- Do not treat every broken pipe as a server crash.
- Do not suppress all broken pipe logs without checking rate and endpoint concentration.
- Do not retry writing to a connection that has already failed.
- Do not keep database or API work running after request cancellation.
- Do not assume the peer is the browser; it may be a proxy, load balancer, service mesh, or upstream service.
- Do not raise timeouts before proving which layer closes first.

## Related errors and how they differ

| Error | Difference |
| --- | --- |
| `connection reset by peer` | peer sent an abortive reset; your next write may become broken pipe |
| `socket hang up` | common runtime-level wording for a socket closed before request/response completion |
| `nginx 499` | Nginx saw downstream close before response completion |
| `upstream prematurely closed connection` | Nginx saw the upstream close too early |

These errors often appear in the same incident from different viewpoints.

## Incident note template

```text
time window:
service:
endpoint:
request id:
write path: headers / small body / large body / stream / upstream request body
error text:
client/proxy log:
Nginx status and timing:
bytes sent:
request duration:
upstream duration:
FIN/RST first sender:
timeout settings:
deploy or config change:
did app continue work after close:
confirmed closing side:
fix applied:
verification after fix:
```

This keeps the incident evidence-based instead of treating `broken pipe` as a generic network error.

## Short checklist

- Treat broken pipe as a write-path failure.
- Find who closed first before changing timeouts.
- Compare app logs with proxy/client logs.
- Use packet capture only to prove close order, not root cause alone.
- Make long-running and streaming code cancellation-aware.
- Separate normal user aborts from systematic slow paths.

## References

- [Linux `write(2)` manual: `EPIPE` and `SIGPIPE`](https://man7.org/linux/man-pages/man2/write.2.html)
- [POSIX `write()` specification: `EPIPE`](https://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html)
- [Linux `pipe(7)` manual: read end closed, `SIGPIPE`, and `EPIPE`](https://man7.org/linux/man-pages/man7/pipe.7.html)
- [Linux `send(2)` manual: `MSG_NOSIGNAL` and `EPIPE`](https://man7.org/linux/man-pages/man2/send.2.html)
