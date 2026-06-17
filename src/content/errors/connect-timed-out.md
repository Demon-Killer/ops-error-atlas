---
title: 'How to debug "connect timed out" errors'
description: A practical connect timed out guide that separates DNS, routing, firewall drops, TCP SYN loss, listener backlog pressure, load balancers, and wrong targets.
slug: connect-timed-out
publishedAt: 2026-06-17
updatedAt: 2026-06-17
tags:
  - TCP
  - Linux
  - networking
related:
  - connection-refused
  - no-route-to-host
  - curl-28-operation-timed-out
  - intermittent-packet-loss
---

`connect timed out` means a client tried to establish a connection but did not complete the connect phase before its deadline. For TCP, that usually means the SYN/SYN-ACK exchange did not finish in time.

This is different from a read timeout. A connect timeout happens before the application has a usable connection. The server may not have received the attempt, the return path may be broken, a firewall may be dropping packets, the load balancer may point to an unhealthy target, or the listener may be under pressure.

The useful question is:

```text
Did the SYN reach the intended target, and did a SYN-ACK come back?
```

## Connect timeout vs similar errors

| Error | Practical meaning |
| --- | --- |
| `connect timed out` | connection setup did not finish |
| `connection refused` | target actively rejected the connect attempt |
| `no route to host` | routing or policy failed before connect could proceed |
| `read timed out` | connection existed, but response data did not arrive in time |
| `connection reset by peer` | connection existed, then was reset |

Do not treat all timeouts as upstream slowness. If connect never completes, application handlers usually did not run.

## Capture the exact tuple

Write down:

```text
source host/container/pod:
source IP:
destination hostname:
resolved destination IP:
destination port:
protocol:
connect timeout value:
timestamp:
```

Then test from the same source:

```bash
getent hosts api.example.com
nc -vz -w 3 api.example.com 443
curl -v --connect-timeout 3 https://api.example.com/
```

If the hostname resolves to multiple IPs, test each IP while preserving the hostname when TLS or virtual hosts matter:

```bash
curl -v --connect-timeout 3 --resolve api.example.com:443:<ip> https://api.example.com/
```

## Check local routing

Before blaming the remote service:

```bash
ip route get <destination-ip>
ip addr
```

Look for:

- unexpected interface;
- unexpected source address;
- missing route;
- VPN route override;
- container or pod namespace mismatch;
- IPv6 chosen when IPv4 is expected, or the reverse.

If `ip route get` cannot choose a path, start with routing. If it chooses a path but connect times out, move to packet evidence.

## Use packet capture to prove the phase

On the client:

```bash
tcpdump -tttt -nn -i any host <destination-ip> and port <port>
```

Interpretation:

| Packet pattern | Meaning |
| --- | --- |
| SYN leaves, no SYN-ACK returns | drop, route, firewall, target down, or return path issue |
| no SYN leaves | local route, local firewall, or application did not attempt connect |
| SYN-ACK returns, client sends ACK | connect succeeded; later timeout is not connect phase |
| RST returns | refusal or active reject, not timeout |
| ICMP unreachable returns | route or policy failure |
| repeated SYN retransmissions | packet loss, drop, unreachable target, or return-path failure |

A single client-side capture may not prove where packets disappear. If possible, capture near the target or check cloud flow logs and firewall logs.

## Case 1: Firewall drop instead of reject

Strong signals:

- client sends SYN repeatedly;
- no SYN-ACK or RST returns;
- one source subnet works while another times out;
- security group, NACL, host firewall, NetworkPolicy, or appliance has a deny/drop rule.

Fix path:

- allow the specific source, destination, protocol, and port;
- avoid broad allow-all changes;
- decide whether failed clients should be dropped or actively rejected;
- verify with `nc -vz` or `curl --connect-timeout`.

Drops create timeouts. Rejects often create immediate refusal-like errors.

## Case 2: Wrong target or stale load balancer member

Strong signals:

- only some resolved IPs time out;
- DNS returns old addresses;
- load balancer target health is stale;
- one availability zone or node is affected;
- direct target tests differ from the public hostname.

Checks:

```bash
getent hosts api.example.com
for ip in <ip1> <ip2> <ip3>; do
  curl -v --connect-timeout 3 --resolve api.example.com:443:$ip https://api.example.com/
done
```

Fix path:

- remove unhealthy targets;
- fix health checks;
- verify DNS TTL and stale records;
- test each backend target directly with hostname preservation.

## Case 3: Listener backlog or host pressure

A busy host can make connect look like a network issue.

Check listener state and queues:

```bash
ss -ltnp
ss -s
netstat -s | egrep -i 'listen|overflow|retrans|reset'
```

Look for:

- listen queue overflow;
- SYN backlog pressure;
- CPU or softirq saturation;
- connection tracking table pressure;
- process not accepting fast enough;
- load balancer opening too many new connections.

Fix path:

- reduce connection churn with keepalive or pooling;
- increase accept capacity only after proving queue pressure;
- scale the listener or fix worker blockage;
- inspect host CPU, memory, softirq, and conntrack.

## Case 4: Container or Kubernetes network path

Host tests can mislead when the failing client is a pod or container.

Docker:

```bash
docker exec -it <container> ip route
docker exec -it <container> nc -vz -w 3 api.example.com 443
```

Kubernetes:

```bash
kubectl exec -it <pod> -- ip route
kubectl exec -it <pod> -- nc -vz -w 3 api.example.com 443
kubectl get networkpolicy -A
```

Common causes:

- NetworkPolicy blocks egress;
- node route or CNI issue;
- service mesh sidecar intercepts traffic;
- NAT or conntrack pressure on one node;
- pod uses a different DNS answer or IP family.

## Case 5: IPv6 and dual-stack surprises

If a hostname returns both A and AAAA records, the client may attempt IPv6 first.

Test both:

```bash
curl -4 -v --connect-timeout 3 https://api.example.com/
curl -6 -v --connect-timeout 3 https://api.example.com/
```

Strong signals:

- IPv4 works but IPv6 times out;
- only some clients prefer IPv6;
- firewall rules allow one family but not the other;
- DNS contains stale AAAA records.

Fix path:

- fix IPv6 routing/firewall;
- remove stale AAAA records if IPv6 is not supported;
- avoid forcing one IP family as a hidden workaround without recording why.

## What not to do

- Do not raise read timeout when connect phase is failing.
- Do not test only from a laptop.
- Do not stop after proving DNS resolution.
- Do not assume a running service means the network path reaches it.
- Do not ignore multiple resolved IPs.
- Do not call it upstream slowness before proving a SYN-ACK.

## Decision tree

```text
connect timed out
|
+-- hostname resolves?
|   +-- no -> debug DNS
|
+-- route exists from failing namespace?
|   +-- no -> debug route/VPN/pod network
|
+-- SYN leaves client?
|   +-- no -> local route/firewall/app behavior
|
+-- SYN-ACK returns?
|   +-- no -> drop, target, firewall, return path, LB target
|
+-- RST returns?
|   +-- active reject/refused, not timeout
|
+-- connect succeeds but request times out?
    +-- debug TLS/read/upstream/application phase
```

## Minimal incident note

```text
error:
source namespace:
destination hostname:
resolved IPs:
destination port:
connect timeout:
route output:
client packet capture:
target or firewall evidence:
load balancer target:
IPv4/IPv6 result:
confirmed failing phase:
fix:
verification:
```

The incident is solved when the failing source can complete the connect phase to the intended target and packet evidence matches the expected path.

## References

- [Linux `connect(2)` manual page](https://man7.org/linux/man-pages/man2/connect.2.html)
- [Linux `tcp(7)` manual page](https://man7.org/linux/man-pages/man7/tcp.7.html)
- [tcpdump manual page](https://www.tcpdump.org/manpages/tcpdump.1.html)
- [Kubernetes Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
