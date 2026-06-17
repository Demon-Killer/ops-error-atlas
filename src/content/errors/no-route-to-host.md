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
  - connect-timed-out
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

The key point is timing: this error appears before the application protocol becomes relevant. If the kernel cannot select or use a route, debugging HTTP headers, TLS certificates, or application code is premature.

In production, the same hostname may resolve to different IPs from different networks. Always capture the resolved IP and the selected source address when the failure happens.

## Common causes

- No route in the local routing table.
- Wrong subnet or default gateway.
- VPN route not installed.
- Security group, firewall, or ACL rejects the path.
- Container or pod network cannot reach the target subnet.
- Destination host or gateway is down.

## Build a route decision record

For a real incident, write down:

```text
source host or pod:
source IP selected by kernel:
destination hostname:
destination IP:
interface:
gateway:
namespace: host, container, pod, VPN, or cloud subnet
```

This prevents a common mistake: testing from an admin laptop and assuming the service host has the same route. Containers, pods, VPN clients, and cloud instances often have different route tables.

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

Example output to pay attention to:

```text
<target-ip> via <gateway> dev <interface> src <source-ip>
```

If the selected `src` address is wrong, replies may never return even when the route appears to exist.

### Inspect routes and interfaces

```bash
ip route
ip addr
ip link
```

Look for missing default routes, wrong subnet masks, and down interfaces.

Also check policy routing when the host has multiple networks:

```bash
ip rule
ip route show table all
```

Policy routing can make two processes on the same machine take different paths if they bind different source addresses or run in different namespaces.

### Test gateway and destination

```bash
ping <gateway-ip>
ping <target-ip>
traceroute <target-ip>
```

If the gateway is unreachable, fix local network or route config first.

If `ping` is blocked, use a protocol-specific test:

```bash
nc -vz <target-ip> <port>
curl -v --connect-timeout 3 http://<target-ip>:<port>/
```

ICMP being blocked does not automatically mean TCP is blocked, and TCP failing does not automatically prove ICMP should fail.

### Check firewall and policy

```bash
iptables -L -n
nft list ruleset
```

Some firewalls reject traffic in a way that surfaces as host unreachable or no route style failures.

For cloud networks, check both sides:

```text
source subnet route table
source security group or firewall
destination security group or firewall
network ACL or equivalent stateless rule
VPN or peering route propagation
```

Cloud route tables and host route tables must agree. A route on the Linux host does not help if the VPC or subnet route table drops the packet later.

### In containers

```bash
docker exec -it <container> ip route
docker exec -it <container> ip addr
```

Do not assume the container has the same routes as the host.

For Kubernetes:

```bash
kubectl exec -it <pod> -- ip route
kubectl exec -it <pod> -- getent hosts <name>
kubectl exec -it <pod> -- nc -vz <target-ip> <port>
```

Run tests from the pod network namespace when the application runs in a pod. Node-level tests can miss CNI, NetworkPolicy, and service-routing problems.

## How to separate similar errors

| Error | Practical meaning |
| --- | --- |
| `no route to host` | path or routing failed before connection setup completed |
| `connection refused` | target was reached but no service accepted the connection |
| `connection timed out` | packets were sent but no timely response came back |
| `DNS server unreachable` | resolver could not be reached before target IP was known |

## Decision table

| Evidence | Likely owner | Next step |
| --- | --- | --- |
| `ip route get` fails | local route table | add or restore route |
| gateway cannot be reached | local subnet or gateway | fix interface, subnet, gateway, or VPN |
| route exists but source IP is wrong | routing policy or bind address | fix source address selection |
| host works, container fails | container namespace or overlay | inspect bridge, CNI, and pod policy |
| pod works on one node only | node route, CNI, or cloud subnet | compare node routes and network plugin state |
| route works but firewall rejects | ACL/security group/firewall | allow source, destination, protocol, and port |

## What not to assume

- Do not debug HTTP first.
- Do not assume DNS is the issue after an IP route failure.
- Do not test only from the host if the app runs in a container or pod.
- Do not ignore firewall rejects when route tables look correct.
- Do not assume route tables are identical across availability zones, subnets, or nodes.

## How to fix it

### If the route is missing

- add the correct route;
- fix default gateway;
- restore VPN or private subnet routes.

Make route changes through the system that owns the environment when possible. For cloud hosts, fix the cloud route table or VPN propagation instead of adding a one-off route that disappears on rebuild.

### If the interface is down or wrong

- bring up the expected interface;
- fix subnet mask or address configuration;
- check link state and virtual network attachment.

### If firewall or policy rejects traffic

- allow the required source/destination pair;
- check cloud security groups and route tables;
- check Kubernetes NetworkPolicy if pods are involved.

Firewall fixes should specify source CIDR, destination CIDR, protocol, and port. Broad "allow all" changes may hide the diagnosis and create security debt.

### If only containers fail

- inspect container network mode;
- verify bridge, overlay, or pod network routes;
- test from the same namespace as the application.

For Kubernetes, check CNI health, node routes, service endpoints, and NetworkPolicy. A pod can have a default route and still fail because policy drops the specific destination.

## Escalation evidence

If you need another team to fix the network path, include:

- failing source IP and destination IP;
- output of `ip route get <target-ip>`;
- source namespace: host, container, pod, or VPN client;
- timestamp of the failure;
- protocol and port;
- whether another host in the same subnet succeeds;
- relevant firewall or security-group IDs.

## Short checklist

- Use `ip route get <target-ip>` first.
- Confirm source interface and gateway.
- Compare host and container network views.
- Separate routing failure from refusal and timeout.
- Fix the path before debugging application code.
- Capture source IP and namespace so the test matches the failing application.
