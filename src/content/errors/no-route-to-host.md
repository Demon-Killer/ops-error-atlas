---
title: 'What does "no route to host" mean?'
description: A practical no route to host guide that separates missing routes, gateway failures, firewall rejects, container networks, Kubernetes policies, and unreachable subnets.
slug: no-route-to-host
publishedAt: 2026-04-30
updatedAt: 2026-05-20
tags:
  - Linux
  - routing
  - networking
related:
  - connection-refused
  - dns-server-unreachable
  - high-network-latency
  - io-timeout
---

`no route to host` means the operating system or network path cannot find a usable route to the destination. It usually happens before HTTP, TLS, or application logic matters. The first investigation should be routing and reachability, not application code.

## What it means

The local host tried to reach a destination IP, but the network stack could not complete the path. Depending on the environment, this may come from:

- missing local route;
- wrong default gateway;
- down interface;
- unreachable subnet;
- firewall reject;
- container network isolation;
- Kubernetes NetworkPolicy or service routing issue.

## Common causes

- No route in the local routing table.
- Wrong subnet or default gateway.
- VPN route not installed.
- Security group, firewall, or ACL rejects the path.
- Container or pod network cannot reach the target subnet.
- Destination host or gateway is down.

## Fast triage order

1. Resolve the hostname to the actual IP if DNS is involved.
2. Check the route Linux would use for that IP.
3. Confirm the source interface and gateway.
4. Test gateway and same-subnet reachability.
5. Compare from host, container, and another working machine.
6. Inspect firewall or network policy if routes look correct.

## Commands to try

### Show the route Linux chooses

```bash
ip route get <target-ip>
```

This is more useful than reading the whole route table first because it shows the selected source address, interface, and gateway.

### Inspect routes and interfaces

```bash
ip route
ip addr
ip link
```

Look for missing default routes, wrong subnet masks, and down interfaces.

### Test gateway and destination

```bash
ping <gateway-ip>
ping <target-ip>
traceroute <target-ip>
```

If the gateway is unreachable, fix local network or route config first.

### Check firewall and policy

```bash
iptables -L -n
nft list ruleset
```

Some firewalls reject traffic in a way that surfaces as host unreachable or no route style failures.

### In containers

```bash
docker exec -it <container> ip route
docker exec -it <container> ip addr
```

Do not assume the container has the same routes as the host.

## How to separate similar errors

| Error | Practical meaning |
| --- | --- |
| `no route to host` | path or routing failed before connection setup completed |
| `connection refused` | target was reached but no service accepted the connection |
| `connection timed out` | packets were sent but no timely response came back |
| `DNS server unreachable` | resolver could not be reached before target IP was known |

## What not to assume

- Do not debug HTTP first.
- Do not assume DNS is the issue after an IP route failure.
- Do not test only from the host if the app runs in a container or pod.
- Do not ignore firewall rejects when route tables look correct.

## How to fix it

### If the route is missing

- add the correct route;
- fix default gateway;
- restore VPN or private subnet routes.

### If the interface is down or wrong

- bring up the expected interface;
- fix subnet mask or address configuration;
- check link state and virtual network attachment.

### If firewall or policy rejects traffic

- allow the required source/destination pair;
- check cloud security groups and route tables;
- check Kubernetes NetworkPolicy if pods are involved.

### If only containers fail

- inspect container network mode;
- verify bridge, overlay, or pod network routes;
- test from the same namespace as the application.

## Short checklist

- Use `ip route get <target-ip>` first.
- Confirm source interface and gateway.
- Compare host and container network views.
- Separate routing failure from refusal and timeout.
- Fix the path before debugging application code.
