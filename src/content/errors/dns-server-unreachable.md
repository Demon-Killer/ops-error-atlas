---
title: 'What does "DNS server unreachable" mean?'
description: A practical DNS server unreachable guide that separates resolver configuration, routing, firewall, UDP/TCP 53, container DNS, and upstream resolver outages.
slug: dns-server-unreachable
publishedAt: 2026-05-14
updatedAt: 2026-05-20
tags:
  - DNS
  - Linux
  - networking
related:
  - no-route-to-host
  - io-timeout
  - curl-28-operation-timed-out
  - high-network-latency
---

`DNS server unreachable` means the host could not contact the configured DNS resolver. The application may report this as a name lookup failure, timeout, or generic network error, but the root problem is earlier: the system cannot reliably reach the resolver that should translate names into IP addresses.

## What it means

Before an application connects to `api.example.com`, it must ask a resolver for an IP address. If the resolver cannot be reached, the request never gets to TCP connect or TLS.

The resolver may be:

- listed in `/etc/resolv.conf`;
- managed by `systemd-resolved`;
- injected by Docker or Kubernetes;
- provided by a VPC, VPN, corporate network, or cloud provider.

The important distinction is between a DNS answer problem and a resolver reachability problem. `NXDOMAIN`, wrong IPs, and stale records mean the resolver answered. `DNS server unreachable` means the client could not reliably talk to the resolver at all.

## Common causes

- Wrong resolver IP.
- Missing route to the resolver subnet.
- Firewall blocks UDP or TCP port 53.
- VPN or VPC DNS is unavailable.
- Container uses a different resolver than the host.
- DNS server is overloaded or rate-limiting.
- Search-domain expansion causes unexpected slow queries.

## Identify the resolver path

Do not start by changing application code. First identify the resolver chain:

```text
application runtime
  -> libc or runtime resolver
  -> local stub resolver, for example 127.0.0.53
  -> upstream resolver
  -> authoritative DNS path
```

In many Linux systems, `/etc/resolv.conf` points to a local stub resolver. The real upstream resolver may be visible only through `resolvectl status` or network manager configuration.

## Fast triage order

1. Identify which resolver the failing process uses.
2. Test direct reachability to the resolver IP.
3. Query the resolver manually with `dig`.
4. Test both UDP and TCP DNS if firewall behavior is suspicious.
5. Compare host, container, and application runtime behavior.
6. Check whether only internal names fail or all names fail.

## Commands to try

### Identify resolver configuration

```bash
cat /etc/resolv.conf
resolvectl status
```

In containers:

```bash
docker exec -it <container> cat /etc/resolv.conf
docker exec -it <container> getent hosts example.com
```

For Kubernetes:

```bash
kubectl exec -it <pod> -- cat /etc/resolv.conf
kubectl exec -it <pod> -- nslookup kubernetes.default.svc.cluster.local
kubectl get svc -n kube-system
```

In Kubernetes environments, pod DNS failures commonly involve CoreDNS, node-local DNS cache, NetworkPolicy, or CNI path issues rather than public DNS.

### Query a specific resolver

```bash
dig @<dns-server-ip> example.com
dig @<dns-server-ip> example.com +tcp
```

Testing TCP helps reveal firewalls that only allow one DNS transport.

Include a short timeout when debugging production failures:

```bash
dig @<dns-server-ip> example.com +time=2 +tries=1
dig @<dns-server-ip> example.com +tcp +time=2 +tries=1
```

This separates quick failures from slow retry behavior that applications may experience as a generic timeout.

### Test reachability

```bash
ping <dns-server-ip>
nc -vz <dns-server-ip> 53
```

Ping may be blocked even when DNS works, so treat it as one signal, not final proof.

For UDP 53, `nc -vz` is not enough because DNS commonly uses UDP first. Use `dig` for the real protocol test.

If routing is suspicious:

```bash
ip route get <dns-server-ip>
```

The selected source address and interface matter for private resolvers.

### Compare resolvers

```bash
dig @1.1.1.1 example.com
dig @8.8.8.8 example.com
dig @<internal-dns-ip> internal.service.local
```

This helps separate public DNS issues from private resolver issues.

Do not replace an internal resolver with a public resolver if the application needs private zones. Public DNS cannot resolve names that only exist inside your VPC, VPN, cluster, or corporate network.

## How to interpret results

| Signal | Likely direction |
| --- | --- |
| public names work, internal names fail | internal DNS, search domain, or private zone |
| host works, container fails | container DNS config or network namespace |
| UDP fails, TCP works | UDP 53 blocked or fragmented responses |
| one resolver fails, another works | resolver outage or routing issue |
| DNS works locally but app fails | runtime DNS cache or resolver config difference |
| `/etc/resolv.conf` points to `127.0.0.53` | inspect `systemd-resolved` upstreams |
| pod DNS fails, node DNS works | CoreDNS, node-local DNS, CNI, or policy |
| internal names fail after VPN change | split DNS or route propagation |
| many names fail slowly | resolver overload or retry storm |

## Search domains can create hidden delays

Search domains can make a short name trigger multiple DNS queries before the final result. In Kubernetes, a lookup like `api` may expand through several cluster search domains before failing or succeeding.

Symptoms:

- DNS time is high but resolver is reachable;
- fully qualified names work faster;
- short internal names behave inconsistently across namespaces;
- logs show repeated queries for similar names.

Useful checks:

```bash
cat /etc/resolv.conf
dig api
dig api.example.com
dig api.example.com.
```

A trailing dot means the name is absolute and should not be expanded by search domains.

## What not to assume

- Do not assume DNS is fine because one host can resolve the name.
- Do not test only from your laptop when the service runs in a container.
- Do not confuse `NXDOMAIN` with unreachable DNS.
- Do not ignore TCP DNS for large or truncated responses.
- Do not point production services at public DNS if they need private records.

## How to fix it

### If resolver config is wrong

- correct `/etc/resolv.conf` or `systemd-resolved` config;
- fix container or Kubernetes DNS settings;
- remove stale VPN-provided resolvers.

Make the fix at the configuration source. Editing `/etc/resolv.conf` directly may be overwritten by DHCP, NetworkManager, `systemd-resolved`, Docker, or Kubernetes.

### If route or firewall blocks DNS

- allow UDP and TCP 53 where required;
- restore the route to internal resolver subnets;
- verify DNS from the same network namespace as the application.

For cloud or corporate networks, confirm both network path and policy. A resolver can be reachable from the host subnet but blocked from pod CIDRs, VPN client ranges, or container bridge networks.

### If resolver is unhealthy

- fail over to a healthy resolver;
- inspect resolver CPU, memory, and query rate;
- reduce retry storms from clients.

Retry storms matter. When resolvers slow down, aggressive clients may increase retries and make the resolver slower. Use bounded retries and caching where appropriate.

## Production evidence to collect

Before escalating DNS:

- failing hostname;
- resolver IP used by the failing process;
- output of `/etc/resolv.conf` from the same namespace;
- `dig @resolver name +time=2 +tries=1` result;
- UDP and TCP behavior;
- whether public names, internal names, or both fail;
- timestamp and affected hosts or pods.

## Short checklist

- Identify the exact resolver used by the failing process.
- Query that resolver directly with `dig`.
- Test from the same host, container, or pod.
- Separate public DNS, private DNS, and search-domain problems.
- Check UDP and TCP DNS before blaming the application.
- Fix resolver config at the owner layer, not with temporary file edits.
