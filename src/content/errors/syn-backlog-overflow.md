---
title: 'How to debug SYN backlog overflow on Linux'
description: A practical SYN backlog overflow guide that separates connection bursts, listener accept pressure, SYN flood symptoms, load balancer churn, kernel counters, and unsafe backlog tuning.
slug: syn-backlog-overflow
publishedAt: 2026-06-17
updatedAt: 2026-06-17
tags:
  - Linux
  - TCP
  - performance
related:
  - connect-timed-out
  - connection-refused
  - tcp-retransmissions
  - high-network-latency
---

SYN backlog overflow means the system cannot keep up with incoming TCP connection attempts for a listening socket. Clients may see connect timeouts, intermittent connection failures, high connection latency, or resets depending on kernel settings and network behavior.

The useful question is:

```text
Is the listener under a real connection burst, or is the application not accepting fast enough?
```

Do not start by changing every TCP sysctl. First prove which listener is pressured and whether the pressure comes from legitimate traffic, load balancer churn, SYN flood behavior, or application accept bottlenecks.

## Look for kernel evidence

Check TCP counters:

```bash
netstat -s | egrep -i 'listen|overflow|SYN|reset|retrans'
```

On modern systems:

```bash
nstat -az | egrep -i 'Listen|Syncookies|Retrans|Reset'
```

Look for counters such as:

- listen queue overflow;
- SYNs to LISTEN sockets dropped;
- SYN cookies sent;
- retransmitted SYN/SYN-ACK;
- reset spikes.

Counter names vary by kernel and tool output, so preserve the exact command output and timestamp.

## Inspect listeners and queues

```bash
ss -ltnp
ss -s
```

For a specific port:

```bash
ss -ltnp '( sport = :443 )'
```

Check:

- which process owns the listener;
- receive queue and send queue hints;
- configured backlog from the application;
- number of workers accepting connections;
- CPU, softirq, and scheduler pressure.

If one listener is affected and others are healthy, start with that process and its accept path.

## Client-side symptom mapping

| Client symptom | Possible backlog branch |
| --- | --- |
| connect timeout | SYN or SYN-ACK not completing |
| intermittent connect latency | queue pressure or retransmission |
| connection refused | listener absent or active reject, not pure backlog |
| reset during handshake | overload behavior, firewall, or application restart |
| failures only during deploy | listener restart or accept gap |

Backlog overflow is one possible cause of connect issues. Packet capture and counters are needed before naming it as root cause.

## Capture handshake behavior

On the server:

```bash
tcpdump -tttt -nn -i any port 443 and 'tcp[tcpflags] & (tcp-syn|tcp-ack) != 0'
```

Patterns:

| Pattern | Meaning |
| --- | --- |
| many SYNs, few SYN-ACKs | server or firewall not responding consistently |
| SYN-ACK leaves, ACK not returning | return path or client-side issue |
| handshake completes but app slow | accept/worker/application pressure |
| SYN retransmissions increase | loss, queueing, or dropped handshake packets |

If packet capture is too expensive on a busy host, sample carefully and use flow logs or load balancer metrics.

## Case 1: Application not accepting fast enough

Strong signals:

- listener process CPU-bound or blocked;
- worker count too low;
- accept loop blocked by expensive work;
- deploy introduced synchronous startup or TLS work before accept;
- backlog counters rise while CPU or run queue is high.

Checks:

```bash
top -H -p <pid>
pidstat -t -p <pid> 1
journalctl -u <service> --since -30m
```

Fix path:

- separate accept loop from slow work;
- increase worker capacity where appropriate;
- reduce per-connection startup cost;
- use connection reuse upstream of the service;
- scale instances if the traffic pattern is legitimate.

## Case 2: Load balancer connection churn

Strong signals:

- new connection rate spikes without matching request rate;
- keepalive disabled or too short;
- load balancer health checks are too frequent;
- clients do not reuse connections;
- TLS handshakes spike at the same time.

Fix path:

- enable or tune keepalive;
- reduce unnecessary connection churn;
- check load balancer health check interval and target count;
- spread load across more targets;
- verify idle timeout alignment.

Backlog tuning cannot fully compensate for avoidable connection churn.

## Case 3: SYN flood or unwanted traffic

Strong signals:

- many source IPs with incomplete handshakes;
- SYN cookies increase sharply;
- request rate is low but SYN rate is high;
- traffic source does not match normal clients;
- firewall/load balancer security logs show attack patterns.

Fix path:

- use upstream DDoS or firewall controls;
- rate limit at the edge;
- preserve packet evidence;
- avoid blocking legitimate clients with broad rules;
- monitor SYN cookie and backlog counters after mitigation.

## Tuning branch

Relevant settings may include:

```bash
sysctl net.core.somaxconn
sysctl net.ipv4.tcp_max_syn_backlog
sysctl net.ipv4.tcp_syncookies
```

Application backlog also matters. For example, a server may call `listen(fd, backlog)` with a small backlog even if kernel limits are larger.

Fix path:

- confirm application backlog;
- align app backlog with kernel limits;
- tune per-service, not as a blind host-wide change;
- monitor memory and connection behavior after changes.

## What not to do

- Do not change sysctls before identifying the listener and traffic pattern.
- Do not ignore application accept speed.
- Do not assume every connect timeout is backlog overflow.
- Do not disable SYN cookies without understanding attack exposure.
- Do not miss load balancer keepalive and health-check churn.

## Decision tree

```text
suspected SYN backlog overflow
|
+-- kernel counters increasing?
|   +-- preserve netstat/nstat output
|
+-- which listener owns the pressure?
|   +-- inspect ss -ltnp and process state
|
+-- app not accepting fast enough?
|   +-- inspect CPU, workers, accept loop, deploy changes
|
+-- new connection rate abnormal?
|   +-- inspect LB/client keepalive and health checks
|
+-- many incomplete handshakes from unusual sources?
    +-- inspect SYN flood/unwanted traffic branch
```

## Minimal incident note

```text
listener port:
process:
client symptom:
counter output:
new connection rate:
request rate:
CPU/softirq:
worker state:
packet sample:
load balancer behavior:
suspected branch:
fix:
verification:
```

The incident is solved when handshake failures stop under the same load pattern and the listener can accept connections without rising backlog/drop counters.

## References

- [Linux `tcp(7)` manual page](https://man7.org/linux/man-pages/man7/tcp.7.html)
- [Linux `listen(2)` manual page](https://man7.org/linux/man-pages/man2/listen.2.html)
- [Linux `ss(8)` manual page](https://man7.org/linux/man-pages/man8/ss.8.html)
- [tcpdump manual page](https://www.tcpdump.org/manpages/tcpdump.1.html)
