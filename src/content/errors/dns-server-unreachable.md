---
title: 'What does "DNS server unreachable" mean?'
description: A practical DNS server unreachable guide that separates resolver configuration, routing, firewall, UDP/TCP 53, container DNS, and upstream resolver outages.
slug: dns-server-unreachable
publishedAt: 2026-05-14
updatedAt: 2026-06-02
tags:
  - DNS
  - Linux
  - networking
related:
  - temporary-failure-in-name-resolution
  - no-route-to-host
  - io-timeout
  - curl-28-operation-timed-out
  - high-network-latency
---

`DNS server unreachable` means the client could not reliably reach the DNS resolver it was configured to use. The application may report this as a lookup timeout, temporary name resolution failure, `i/o timeout`, `no such host`, or a generic dependency error, but the failed phase is earlier than TCP connect or TLS: name resolution did not complete.

The first distinction is:

```text
resolver unreachable != name does not exist
```

`NXDOMAIN` means a resolver answered that the name does not exist in that DNS view. `SERVFAIL` means a resolver answered but failed to complete resolution. A timeout or unreachable resolver means the client did not get a usable answer from the resolver path at all.

The useful question is not "is DNS down?" It is:

```text
Which resolver did the failing process use, and could that exact process reach it over the required DNS transport?
```

Do not change application retry logic, connection pools, or HTTP timeouts until the resolver path is proven.

## The DNS Path You Are Debugging

A Linux process commonly follows a chain like this:

```text
application runtime
  -> libc or language resolver
  -> /etc/resolv.conf
  -> optional local stub resolver, for example 127.0.0.53
  -> upstream recursive resolver
  -> authoritative DNS path
```

In containers and Kubernetes, the chain may be different:

```text
pod or container
  -> its own /etc/resolv.conf
  -> cluster DNS service, often CoreDNS
  -> optional node-local DNS cache
  -> upstream recursive resolver
  -> authoritative DNS path
```

The resolver used by your laptop, the host, the container, and the application runtime may not be the same. Always test from the same network namespace as the failing process.

## What This Error Proves

It proves:

- the client did not receive a usable DNS answer before its deadline;
- the failure happened before normal TCP connection setup to the final hostname;
- the configured resolver path is a primary suspect;
- the final application server may not have been contacted at all.

It does not prove:

- the domain name is wrong;
- public DNS is down;
- the authoritative DNS server is unreachable from everywhere;
- the application server is unavailable;
- switching to `8.8.8.8` or `1.1.1.1` is safe for the workload.

Public resolvers cannot resolve private zones that exist only inside a VPC, VPN, corporate network, or Kubernetes cluster. Replacing an internal resolver with a public resolver may hide the timeout while breaking private service discovery.

## Start With The Resolver Used By The Failing Process

On a Linux host:

```bash
cat /etc/resolv.conf
resolvectl status
getent hosts example.com
```

The `resolv.conf(5)` manual defines `nameserver`, `search`, and resolver `options` such as `ndots`, `timeout`, and `attempts`. If `/etc/resolv.conf` points to `127.0.0.53`, the process may be using the `systemd-resolved` local stub. The actual upstream DNS servers are then usually visible in `resolvectl status`, not just in `/etc/resolv.conf`.

Inside Docker:

```bash
docker exec -it <container> cat /etc/resolv.conf
docker exec -it <container> getent hosts example.com
```

Inside Kubernetes:

```bash
kubectl exec -it <pod> -- cat /etc/resolv.conf
kubectl exec -it <pod> -- getent hosts kubernetes.default.svc.cluster.local
kubectl exec -it <pod> -- nslookup kubernetes.default.svc.cluster.local
```

Kubernetes documents DNS records for Services and Pods, and kubelet configures containers to use cluster DNS according to pod DNS policy. That means host DNS success does not prove pod DNS success.

## Query The Resolver Directly

Use `dig` against the exact resolver IP.

```bash
dig @<dns-server-ip> example.com +time=2 +tries=1
dig @<dns-server-ip> example.com +tcp +time=2 +tries=1
```

Interpret the result by layer:

| Result | Meaning | First branch |
| --- | --- | --- |
| timeout to resolver | Resolver unreachable, packet drop, firewall, route, or overload | Route, firewall, resolver health |
| UDP fails, TCP works | UDP 53 blocked, fragmented UDP, or middlebox behavior | UDP firewall, MTU, path |
| TCP fails, UDP works | TCP 53 blocked or resolver not listening for TCP | Firewall or resolver configuration |
| resolver answers `NXDOMAIN` | Resolver is reachable; name does not exist from that resolver view | Zone, search domain, split DNS |
| resolver answers `SERVFAIL` | Resolver is reachable but failed resolving | Upstream recursion, DNSSEC, resolver health |
| public resolver works, internal resolver fails | Internal resolver path or private DNS issue | VPC, VPN, corporate, or cluster DNS |
| internal name fails on public resolver | Expected if name is private | Use the correct internal resolver |

Testing both UDP and TCP matters because DNS uses both transports. UDP-only tests can miss TCP 53 firewall problems; TCP-only tests can miss UDP path, MTU, and packet-loss problems.

## Test Reachability To The Resolver

Check the route and selected source address:

```bash
ip route get <dns-server-ip>
```

Test DNS behavior with `dig`:

```bash
dig @<dns-server-ip> example.com +time=2 +tries=1
dig @<dns-server-ip> example.com +tcp +time=2 +tries=1
```

If the path is still unclear, capture packets from the failing host:

```bash
tcpdump -tttt -nn -i any host <dns-server-ip> and port 53
```

Packet patterns:

| Packet pattern | Meaning |
| --- | --- |
| query leaves, no response returns | Route, firewall, resolver, or return-path issue |
| no query leaves | Local resolver/runtime did not send, or local firewall blocked |
| response returns after app timeout | Timeout budget too short or resolver response too slow |
| ICMP unreachable returns | Route, firewall, or host unreachable signal |
| TCP connects but DNS query still times out | Resolver application-layer issue |

Ping is only a weak signal. Many resolvers block ICMP while DNS still works.

## Case 1: Wrong Resolver Configuration

Strong signals:

- `/etc/resolv.conf` has stale or unreachable `nameserver` entries;
- VPN or DHCP recently changed resolver settings;
- host uses `127.0.0.53` but `systemd-resolved` upstreams are wrong;
- container or pod DNS config differs from host DNS config;
- the application runtime uses its own resolver behavior.

Fix path:

- fix the configuration owner: NetworkManager, DHCP, VPN client, systemd-resolved, Docker, kubelet, or Kubernetes pod DNS policy;
- avoid hand-editing `/etc/resolv.conf` if it is generated;
- verify from the same process namespace after the fix.

Temporary file edits often disappear after reboot, DHCP renewal, VPN reconnect, container restart, or pod reschedule. Treat `/etc/resolv.conf` as evidence first and as an edit target only after you know who owns it.

## Case 2: Route Or Firewall Blocks DNS

Strong signals:

- `ip route get` selects an unexpected interface or source address;
- `dig @resolver` times out;
- UDP 53 and/or TCP 53 is blocked;
- resolver works from one subnet but not another;
- pod CIDR, container bridge, CI runner, or VPN range cannot reach the resolver.

Fix path:

- allow UDP and TCP 53 where required;
- restore route to internal resolver subnets;
- check security groups, NetworkPolicy, host firewall, VPN policy, and NAT;
- test from the same host, container, or pod as the failing application.

Cloud and corporate environments often allow DNS from host subnets but not from pod, VPN, or container ranges unless explicitly configured.

## Case 3: systemd-resolved Stub Confusion

Strong signals:

- `/etc/resolv.conf` lists `127.0.0.53`;
- direct queries to `127.0.0.53` fail or are slow;
- `resolvectl status` shows unexpected upstream DNS servers;
- one link has stale DNS servers after Wi-Fi, VPN, or network changes;
- split DNS domains route to the wrong link.

Checks:

```bash
resolvectl status
resolvectl query example.com
journalctl -u systemd-resolved --since -30m
```

Fix path:

- correct per-link DNS settings through NetworkManager, systemd-networkd, VPN, or `resolvectl`;
- restart `systemd-resolved` only if configuration and logs support it;
- check whether split DNS domains are assigned to the correct link.

The systemd-resolved documentation describes local DNS stub listeners on `127.0.0.53` and `127.0.0.54`, and explains that upstream DNS servers can come from global config, per-link config, DHCP, `resolvectl`, and other system services. Treat it as a resolver layer, not the final DNS server.

## Case 4: Kubernetes Or Container DNS Path

Strong signals:

- host DNS works, pod DNS fails;
- only pods on one node fail;
- service names fail but public names work, or the reverse;
- CoreDNS pods restart, throttle, or log upstream timeouts;
- NetworkPolicy blocks pod-to-DNS traffic.

Checks:

```bash
kubectl exec -it <pod> -- cat /etc/resolv.conf
kubectl exec -it <pod> -- nslookup kubernetes.default.svc.cluster.local
kubectl -n kube-system get pods
kubectl -n kube-system get svc
kubectl -n kube-system logs deploy/coredns --tail=100
```

The CoreDNS deployment name and labels can differ by cluster, but the investigation is stable:

- can the pod reach the cluster DNS service IP?
- is CoreDNS healthy?
- can CoreDNS reach its upstream resolver?
- do NetworkPolicy, CNI, node-local DNS cache, or service mesh rules block port 53?
- does the pod use `dnsPolicy: Default`, `ClusterFirst`, or custom DNS config?

Kubernetes official docs explain DNS records for Services and Pods and how DNS service behavior can be customized through CoreDNS configuration. Use those docs to identify expected record names before treating a failed lookup as an infrastructure fault.

## Case 5: Search Domains And `ndots` Create Hidden Delay

Strong signals:

- resolver is reachable but lookups are slow;
- short names behave differently from fully qualified domain names;
- Kubernetes pods have several search domains;
- `options ndots:5` or similar causes multiple attempted names;
- absolute names with a trailing dot are faster.

Checks:

```bash
cat /etc/resolv.conf
dig api
dig api.example.com
dig api.example.com.
```

A trailing dot tells the resolver the name is absolute. If `api.example.com.` is fast but `api` is slow, search-domain expansion may be consuming the lookup budget.

Fix path:

- use fully qualified names for cross-namespace or external dependencies;
- reduce unnecessary search domains where appropriate;
- tune `ndots` only with measured evidence;
- avoid short ambiguous names in latency-sensitive dependencies.

The `resolv.conf(5)` manual notes that search-domain processing may be slow and may generate extra traffic if listed domains are not local or if no server is available for one of those domains. In Kubernetes, this effect is common because pod DNS config often includes multiple cluster search domains.

## Case 6: Split DNS Or Private Zones

Strong signals:

- public names resolve but private names fail;
- private names work only on VPN or only inside VPC;
- public resolvers return `NXDOMAIN` for internal records;
- failures start after VPN, route, or DNS policy changes;
- one environment resolves `db.service.internal`, another environment does not.

Fix path:

- identify which resolver is authoritative for the private zone;
- ensure the client is on the correct network path;
- verify split DNS routing for the domain suffix;
- do not replace internal resolvers with public resolvers for private workloads;
- test from each relevant environment: host, container, pod, CI runner, VPN client.

Split DNS failures are resolver selection problems, not application hostname bugs.

## Case 7: Resolver Overload Or Retry Storm

Strong signals:

- many unrelated names fail slowly;
- resolver CPU, memory, or query rate spikes;
- client retries increase during resolver slowness;
- CoreDNS or recursive resolver logs show upstream timeouts;
- application timeout rate rises with DNS latency.

Fix path:

- inspect resolver resource usage and query rate;
- reduce aggressive client retries;
- use bounded retry with jitter;
- cache safely where appropriate;
- add resolver capacity or failover;
- fix the upstream dependency causing resolver recursion delays.

DNS retries can amplify outages. When resolvers slow down, aggressive clients may multiply query load and make the resolver slower.

## Case 8: Resolver Reachable But The Answer Is Wrong

Sometimes the original alert says `DNS server unreachable`, but the evidence shows the resolver is reachable and answering. That is a different incident.

Examples:

- `NXDOMAIN`: the name does not exist from this resolver view;
- `SERVFAIL`: resolver failed, often because of upstream resolution or validation;
- wrong A/AAAA record: the resolver returned an address, but not the expected one;
- stale answer: cache still contains an old record;
- private/public view mismatch: the same name resolves differently from different networks.

In this branch, keep DNS reachability evidence, but move the investigation to zone ownership, record history, TTL, delegation, split-horizon configuration, or resolver cache behavior.

## Decision Tree

```text
DNS server unreachable
|
+-- Which resolver did the failing process use?
|   |
|   +-- inspect /etc/resolv.conf, resolvectl, container/pod DNS
|
+-- dig @resolver times out?
|   |
|   +-- inspect route, firewall, UDP/TCP 53, resolver health
|
+-- UDP fails but TCP works?
|   |
|   +-- inspect UDP 53 firewall, MTU, fragmentation, middlebox behavior
|
+-- host works but container/pod fails?
|   |
|   +-- inspect namespace DNS config, CoreDNS, NetworkPolicy, CNI path
|
+-- public names work but private names fail?
|   |
|   +-- inspect split DNS, VPN/VPC/private zone resolver
|
+-- resolver answers NXDOMAIN or SERVFAIL?
|   |
|   +-- resolver reachable; debug zone/upstream resolver, not reachability
|
+-- short names slow but fully qualified names are fast?
    |
    +-- inspect search domains and ndots
```

## What Not To Do

- Do not confuse `NXDOMAIN` with resolver unreachable.
- Do not test only from your laptop when the service runs in a container or pod.
- Do not assume `/etc/resolv.conf` shows the true upstream when `systemd-resolved` is used.
- Do not use public DNS for workloads that require private records.
- Do not check only UDP or only TCP 53 when firewall behavior is suspicious.
- Do not edit generated resolver files as the final fix.
- Do not ignore search-domain expansion and `ndots` when lookup latency is high.
- Do not increase application timeouts before proving whether DNS requests leave the failing namespace and whether responses return.

## Minimal Incident Note Template

```text
Symptom:
- failing hostname:
- application/runtime:
- host/container/pod:
- time window:
- error text:

Resolver evidence:
- /etc/resolv.conf from failing namespace:
- resolvectl status:
- resolver IP:
- search domains:
- ndots/options:

Query evidence:
- dig @resolver name:
- dig @resolver name +tcp:
- public name result:
- private name result:
- short name vs fully qualified name result:

Network evidence:
- ip route get resolver:
- UDP 53 result:
- TCP 53 result:
- tcpdump packet evidence:
- firewall/NetworkPolicy/security group:

Platform evidence:
- Docker/Kubernetes DNS config:
- CoreDNS logs:
- node-local DNS cache:
- VPN/VPC/split DNS config:

Hypothesis:
- unreachable layer:
- evidence:

Fix:
- config/network/resolver change:
- validation:
```

The incident is solved when the failing process can query the intended resolver over the required transport and receives the expected answer for the relevant DNS view.

## References

- [Linux `resolv.conf(5)` manual page](https://man7.org/linux/man-pages/man5/resolv.conf.5.html)
- [systemd-resolved service documentation](https://man7.org/linux/man-pages/man8/systemd-resolved.service.8.html)
- [resolvectl manual page](https://man7.org/linux/man-pages/man1/resolvectl.1.html)
- [Kubernetes DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Kubernetes Customizing DNS Service](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [BIND 9 manual pages for `dig`](https://bind9.readthedocs.io/en/latest/manpages.html)
- [tcpdump manual page](https://www.tcpdump.org/manpages/tcpdump.1.html)
