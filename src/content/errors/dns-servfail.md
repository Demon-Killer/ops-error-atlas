---
title: 'How to debug DNS SERVFAIL'
description: A practical DNS SERVFAIL guide that separates resolver reachability, authoritative server failure, DNSSEC validation, broken delegation, private zone issues, and transient upstream resolver errors.
slug: dns-servfail
publishedAt: 2026-06-17
updatedAt: 2026-06-17
tags:
  - DNS
  - Linux
  - networking
related:
  - dns-server-unreachable
  - temporary-failure-in-name-resolution
  - no-route-to-host
  - connect-timed-out
---

`SERVFAIL` means a DNS resolver answered the query but failed to complete resolution successfully. This is different from a resolver timeout and different from `NXDOMAIN`. The resolver is reachable, but it could not produce a valid answer.

The useful question is:

```text
Which resolver returned SERVFAIL, and did authoritative DNS, delegation, DNSSEC, or resolver policy cause it?
```

Do not treat `SERVFAIL` as "domain does not exist." A domain can exist and still return `SERVFAIL`.

## Separate SERVFAIL from other DNS failures

| DNS result | Meaning |
| --- | --- |
| timeout | resolver did not return a usable response |
| `NXDOMAIN` | resolver says the name does not exist in that DNS view |
| `SERVFAIL` | resolver failed while trying to answer |
| wrong IP | resolver answered, but data or view is not expected |
| `REFUSED` | resolver policy rejected the query |

`SERVFAIL` is useful because it proves the resolver path is at least partially reachable.

## Query multiple resolvers

Test the resolver used by the failing process:

```bash
dig @<resolver-ip> example.com A +time=2 +tries=1
```

Then compare with another resolver only as evidence:

```bash
dig @1.1.1.1 example.com A +time=2 +tries=1
dig @8.8.8.8 example.com A +time=2 +tries=1
```

Interpretation:

| Result | Branch |
| --- | --- |
| internal resolver SERVFAIL, public resolver answers | internal resolver recursion, policy, private DNS, or DNSSEC path |
| all resolvers SERVFAIL | authoritative zone, delegation, or DNSSEC problem |
| public resolver NXDOMAIN, internal resolver answers | private/split DNS expected |
| only one resolver SERVFAIL | resolver-specific cache, validation, or upstream issue |

Do not replace an internal resolver with public DNS if the name is private.

## Trace authoritative path

Use:

```bash
dig example.com A +trace
dig NS example.com
dig SOA example.com
```

Look for:

- broken delegation;
- unreachable authoritative name servers;
- inconsistent answers between authoritative servers;
- missing glue records;
- lame delegation;
- expired zone data;
- DNSSEC validation problems.

For private zones, public `+trace` may not represent the internal DNS view.

## DNSSEC branch

DNSSEC validation failures often appear as `SERVFAIL` from validating resolvers.

Strong signals:

- non-validating resolver answers, validating resolver returns `SERVFAIL`;
- failures start after DS/DNSKEY/zone signing changes;
- only signed zones fail;
- domain testing tools report DNSSEC errors.

Checks:

```bash
dig example.com A +dnssec
dig example.com DNSKEY
dig example.com DS
```

Fix path:

- repair DS records at the parent zone;
- publish correct DNSKEY records;
- fix expired signatures;
- align registrar and DNS provider DNSSEC settings;
- wait for caches only after the chain is correct.

Do not disable validation globally to hide one broken zone unless you understand the security tradeoff.

## Authoritative server branch

Strong signals:

- all recursive resolvers return `SERVFAIL`;
- authoritative servers time out or disagree;
- one nameserver has stale or broken zone data;
- delegation points to old nameservers;
- recent DNS provider migration.

Checks:

```bash
dig @<authoritative-ns> example.com A
dig @<authoritative-ns> example.com SOA
```

Fix path:

- repair authoritative zone data;
- remove stale nameservers from delegation;
- fix glue records;
- verify all authoritative servers serve the same zone serial and records.

## Resolver overload or upstream failure

Strong signals:

- many unrelated domains return `SERVFAIL`;
- resolver logs show upstream timeout or forwarder failure;
- CoreDNS logs contain `SERVFAIL` or upstream errors;
- resolver CPU, memory, or network is saturated;
- failures are intermittent.

Checks:

```bash
journalctl -u systemd-resolved --since -30m
kubectl -n kube-system logs deploy/coredns --tail=100
```

For BIND, Unbound, CoreDNS, or cloud resolvers, inspect provider-specific logs and metrics.

Fix path:

- restore upstream forwarders;
- reduce retry storms;
- increase resolver capacity;
- fix blocked egress from resolver to upstream DNS;
- verify with the failing resolver, not only public DNS.

## Kubernetes and private DNS branch

Inside clusters, `SERVFAIL` can come from CoreDNS plugin behavior, upstream resolver errors, or private zone forwarding.

Checks:

```bash
kubectl exec -it <pod> -- cat /etc/resolv.conf
kubectl exec -it <pod> -- dig <name>
kubectl -n kube-system logs deploy/coredns --tail=100
kubectl -n kube-system get configmap coredns -o yaml
```

Strong suspects:

- CoreDNS forwarding to unreachable upstreams;
- private zone forwarding misconfigured;
- `stubDomains` or Corefile changes;
- NetworkPolicy blocks DNS egress from CoreDNS;
- split DNS view mismatch.

## What not to do

- Do not call `SERVFAIL` the same as `NXDOMAIN`.
- Do not test only one resolver.
- Do not switch to public DNS for private names.
- Do not ignore DNSSEC after registrar or DNS provider changes.
- Do not debug application code before proving DNS answer behavior.

## Decision tree

```text
DNS SERVFAIL
|
+-- which resolver returned it?
|   +-- query failing resolver directly
|
+-- all resolvers SERVFAIL?
|   +-- inspect authoritative DNS, delegation, DNSSEC
|
+-- only validating resolvers fail?
|   +-- inspect DNSSEC chain
|
+-- only internal resolver fails?
|   +-- inspect resolver forwarding, private DNS, CoreDNS, policy
|
+-- many domains fail?
    +-- inspect resolver overload or upstream outage
```

## Minimal incident note

```text
failing name:
record type:
failing resolver:
dig output:
comparison resolver output:
authoritative NS:
DNSSEC status:
private/public zone:
resolver logs:
confirmed branch:
fix:
verification:
```

The incident is solved when the intended resolver returns the expected answer or a correct negative answer, and `SERVFAIL` is no longer present for that DNS view.

## References

- [Linux `resolv.conf(5)` manual page](https://man7.org/linux/man-pages/man5/resolv.conf.5.html)
- [BIND 9 manual pages for `dig`](https://bind9.readthedocs.io/en/latest/manpages.html)
- [Kubernetes DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Cloudflare DNSSEC documentation](https://developers.cloudflare.com/dns/dnssec/)
