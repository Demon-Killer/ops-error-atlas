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

## Common causes

- Wrong resolver IP.
- Missing route to the resolver subnet.
- Firewall blocks UDP or TCP port 53.
- VPN or VPC DNS is unavailable.
- Container uses a different resolver than the host.
- DNS server is overloaded or rate-limiting.
- Search-domain expansion causes unexpected slow queries.

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

### Query a specific resolver

```bash
dig @<dns-server-ip> example.com
dig @<dns-server-ip> example.com +tcp
```

Testing TCP helps reveal firewalls that only allow one DNS transport.

### Test reachability

```bash
ping <dns-server-ip>
nc -vz <dns-server-ip> 53
```

Ping may be blocked even when DNS works, so treat it as one signal, not final proof.

### Compare resolvers

```bash
dig @1.1.1.1 example.com
dig @8.8.8.8 example.com
dig @<internal-dns-ip> internal.service.local
```

This helps separate public DNS issues from private resolver issues.

## How to interpret results

| Signal | Likely direction |
| --- | --- |
| public names work, internal names fail | internal DNS, search domain, or private zone |
| host works, container fails | container DNS config or network namespace |
| UDP fails, TCP works | UDP 53 blocked or fragmented responses |
| one resolver fails, another works | resolver outage or routing issue |
| DNS works locally but app fails | runtime DNS cache or resolver config difference |

## What not to assume

- Do not assume DNS is fine because one host can resolve the name.
- Do not test only from your laptop when the service runs in a container.
- Do not confuse `NXDOMAIN` with unreachable DNS.
- Do not ignore TCP DNS for large or truncated responses.

## How to fix it

### If resolver config is wrong

- correct `/etc/resolv.conf` or `systemd-resolved` config;
- fix container or Kubernetes DNS settings;
- remove stale VPN-provided resolvers.

### If route or firewall blocks DNS

- allow UDP and TCP 53 where required;
- restore the route to internal resolver subnets;
- verify DNS from the same network namespace as the application.

### If resolver is unhealthy

- fail over to a healthy resolver;
- inspect resolver CPU, memory, and query rate;
- reduce retry storms from clients.

## Short checklist

- Identify the exact resolver used by the failing process.
- Query that resolver directly with `dig`.
- Test from the same host, container, or pod.
- Separate public DNS, private DNS, and search-domain problems.
- Check UDP and TCP DNS before blaming the application.
