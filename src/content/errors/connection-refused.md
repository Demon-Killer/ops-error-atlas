---
title: 'Why "connection refused" happens on Linux'
description: A practical guide to connection refused errors that separates missing listeners, bind address mistakes, wrong ports, container networking, and active firewall rejects.
slug: connection-refused
publishedAt: 2026-05-08
updatedAt: 2026-05-21
tags:
  - TCP
  - Linux
  - sockets
related:
  - connection-reset-by-peer
  - connect-timed-out
  - no-route-to-host
  - address-already-in-use
  - nginx-502-bad-gateway
---

`connection refused` means a connection attempt was actively rejected instead of silently timing out. On Linux, the `connect(2)` manual describes `ECONNREFUSED` for stream sockets as the case where nobody is listening on the remote address.

That definition is useful, but production systems add layers. "Nobody is listening" may mean:

- the process is not running;
- the process is listening on a different port;
- the process is bound only to `127.0.0.1`;
- Docker published the wrong host port;
- Kubernetes Service points to the wrong `targetPort` or has no ready endpoints;
- a firewall, proxy, or load balancer actively rejects the attempt.

The useful question is not "is the server up?" The useful question is:

```text
Which exact IP, port, protocol, and network namespace rejected the connection?
```

## A realistic incident shape

This is an example scenario, not a claim about how all incidents behave.

A deploy finishes successfully. The service manager says the app is running, but clients report:

```text
connect: connection refused
curl: (7) Failed to connect to api.example.com port 8080
```

The wrong first move is to restart everything. The better move is to prove the connection target and listener state.

## Refused is different from timeout

These errors point to different layers:

| Error | Practical meaning |
| --- | --- |
| `connection refused` | something actively rejected the connect attempt |
| `connection timed out` | no useful response arrived before the client deadline |
| `no route to host` | routing, gateway, interface, or policy failed before connect completed |
| `connection reset by peer` | a connection existed, then the peer reset it |

This distinction matters. A timeout often starts with routing, firewall drops, packet loss, or listener backlog. A refusal starts with the listener, bind address, port mapping, service target, or active reject behavior.

## First prove the connection tuple

Write down the tuple before touching configs:

```text
source host / pod / container:
source network namespace:
destination hostname:
resolved destination IP:
destination port:
protocol: TCP
test command:
timestamp:
```

Many wrong fixes happen because the operator checks a listener in one namespace while the client connects from another.

## First diagnostic commands

From the failing client environment:

```bash
getent hosts api.example.com
nc -vz api.example.com 8080
curl -v --connect-timeout 3 http://api.example.com:8080/
```

The timeout value above is just a diagnostic example. Use a value appropriate for your environment.

On the target host:

```bash
ss -ltnp
ss -ltnp '( sport = :8080 )'
```

Look for:

```text
LISTEN 0 4096 127.0.0.1:8080
LISTEN 0 4096 0.0.0.0:8080
LISTEN 0 4096 [::]:8080
```

Those are not equivalent. A service listening only on `127.0.0.1` is local to that network namespace. A service listening on `0.0.0.0` accepts connections on all IPv4 addresses in that namespace. IPv6 dual-stack behavior depends on runtime and system configuration, so verify it instead of assuming.

## If local works but remote fails

Run both tests:

```bash
curl -v http://127.0.0.1:8080/
curl -v http://<server-ip>:8080/
```

Interpretation:

| Observation | Strong suspect |
| --- | --- |
| localhost works, server IP refused | service bound only to localhost or namespace mismatch |
| server IP works locally, remote refused | firewall, security group, proxy, or different target IP |
| one resolved IP refused, another works | one bad backend behind DNS or load balancing |
| service active, no listener | app started but failed before binding expected port |
| listener exists, client still refused | wrong host, namespace, firewall reject, or proxy path |

Do not stop at `systemctl status` showing active. Confirm the actual listening socket.

## Check the process and startup path

```bash
systemctl status your-service
journalctl -u your-service --since -30m
```

Common service-side causes:

- startup failed before binding;
- process crashed after health check registration;
- config points to a different port;
- another process already owns the port;
- service binds only after initialization and clients arrive too early;
- old and new versions use different port settings.

Check the owning process:

```bash
ss -ltnp '( sport = :8080 )'
ps -fp <pid>
readlink /proc/<pid>/exe
tr '\0' ' ' < /proc/<pid>/cmdline
```

This prevents a common mistake: proving that something is listening, but not the service you expected.

## Bind address mistakes

Binding is about address scope.

| Bind address | Reachability meaning |
| --- | --- |
| `127.0.0.1:<port>` | local loopback only inside that namespace |
| `0.0.0.0:<port>` | all IPv4 interfaces in that namespace |
| `<private-ip>:<port>` | only that specific interface address |
| `::1:<port>` | IPv6 loopback |
| `[::]:<port>` | IPv6 unspecified address; IPv4 behavior depends on configuration |

Use `0.0.0.0` only when the service should be reachable beyond localhost. For admin interfaces, metrics endpoints, and debug ports, localhost binding may be intentional.

## Docker: published port vs container port

Inside Docker, the container has its own network namespace unless configured otherwise.

Check:

```bash
docker ps
docker port <container>
docker exec -it <container> ss -ltnp
docker logs <container>
```

The important distinction:

```text
container listens on 127.0.0.1:8080 inside the container
host publishes 0.0.0.0:18080 -> container:8080
client connects to host:18080
```

If the app binds to `127.0.0.1` inside the container, publishing the port may not expose it the way you expect. Prefer binding the service to the intended container interface and publishing only the host port that should be reachable.

Docker documentation describes publishing as mapping a container port to a host port. Do not assume the host port and container port are the same.

## Kubernetes: Service port, targetPort, and endpoints

For Kubernetes, check the Service and endpoints:

```bash
kubectl get svc,endpointslices,pod -o wide
kubectl describe svc <service>
kubectl get pod --show-labels
kubectl exec -it <pod> -- nc -vz <service-name> <port>
```

Kubernetes Services route traffic from a Service `port` to a backend `targetPort`. The API server updates EndpointSlices for Services based on matching Pods. A mismatch can make the Service exist while traffic does not reach the expected container port.

Common Kubernetes causes:

- Service selector does not match the Pods;
- Pods are not Ready, so they are not valid endpoints;
- `targetPort` does not match the container listener;
- app listens on localhost inside the container;
- NetworkPolicy blocks the source;
- client is using the wrong Service name or namespace;
- NodePort, Ingress, or load balancer points to a different port than expected.

Useful checks:

```bash
kubectl describe endpointslice -l kubernetes.io/service-name=<service>
kubectl exec -it <pod> -- ss -ltnp
kubectl exec -it <pod> -- curl -v http://127.0.0.1:<target-port>/
```

If the app works on `127.0.0.1` inside the pod but the Service fails, inspect Service selector, readiness, targetPort, and policy.

## Firewall and active rejects

A firewall can drop traffic or reject it. These are operationally different:

| Behavior | Client symptom |
| --- | --- |
| drop | timeout is more likely because no explicit response is returned |
| reject with TCP reset | refusal-like failure can appear immediately |
| reject with ICMP | client may report unreachable or refused depending on stack/tool |

Check Linux firewall rules:

```bash
iptables -S
nft list ruleset
```

Search for explicit rejects:

```bash
iptables -S | grep -i reject
nft list ruleset | grep -i reject
```

Cloud firewalls, security groups, network ACLs, API gateways, service meshes, and load balancers can also reject. If the host listener is correct but the client still gets refused, inspect the path between them.

## DNS and load balancing

If the hostname resolves to multiple IPs, test each target while preserving the hostname when HTTP virtual hosts or TLS SNI matter.

For HTTP:

```bash
curl -v --connect-timeout 3 http://<ip-address>:8080/
```

For HTTPS, preserve the hostname:

```bash
curl -v --resolve api.example.com:443:<ip-address> https://api.example.com/
```

Do this when:

- only some requests fail;
- the error appears after a deploy;
- one load-balanced node is missing a listener;
- DNS returns different answers from different networks;
- an upstream pool includes a stale instance.

## Decision tree

```text
1. Capture source, destination hostname, resolved IP, port, and namespace.
2. Test from the failing client environment.
3. Check listener on the target host or target container/pod.
4. If no listener exists, inspect service startup and bind config.
5. If listener is localhost-only, fix bind address or client path.
6. If listener exists and local test works, test from remote source.
7. If remote fails, inspect firewall, security group, proxy, or port publishing.
8. If DNS returns multiple IPs, test each backend target.
9. If Kubernetes is involved, verify Service selector, EndpointSlice, readiness, and targetPort.
10. Change config only after proving which layer refused.
```

## Fixes by evidence

### If no process is listening

- start the service;
- inspect crash and startup logs;
- check port configuration;
- check whether another process owns the intended port;
- verify the listener after restart with `ss -ltnp`.

### If the bind address is wrong

- bind to the intended interface;
- keep local-only services on loopback;
- bind externally reachable services to the correct address;
- verify IPv4 and IPv6 separately when dual-stack matters.

### If Docker port publishing is wrong

- confirm the container listener with `docker exec`;
- confirm host mapping with `docker port`;
- publish the intended host port;
- avoid assuming container port and host port are identical.

### If Kubernetes Service routing is wrong

- fix selectors and labels;
- fix `targetPort`;
- verify Pod readiness;
- inspect EndpointSlices;
- test from a pod in the same namespace and from the real client namespace.

### If firewall or policy rejects

- confirm the reject rule is intentional;
- allow the specific source, destination, protocol, and port;
- avoid broad allow-all changes;
- document whether rejected clients should fail fast or time out.

## What not to do

- Do not restart everything before checking the listener.
- Do not test only `localhost` on the server.
- Do not assume `127.0.0.1` inside a container means the host can connect.
- Do not treat refusal and timeout as the same class of failure.
- Do not debug DNS first if you already know the exact IP and it refuses.
- Do not declare a service healthy without checking the actual listening socket.
- Do not test only one IP when the hostname resolves to multiple targets.

## Incident note template

```text
error message:
client host / pod / container:
client namespace:
destination hostname:
resolved IP:
destination port:
test command:
listener output:
process owner:
bind address:
Docker port mapping:
Kubernetes Service / targetPort / EndpointSlice:
firewall or security group:
load balancer target:
recent deploy or config change:
confirmed refusing layer:
fix applied:
verification command:
```

This keeps the investigation evidence-based instead of relying on "the service is up" or "network issue" as vague explanations.

## Short checklist

- Prove the exact IP, port, and namespace.
- Check the actual listener with `ss -ltnp`.
- Compare localhost, server IP, and remote-client tests.
- For Docker, separate container port from host published port.
- For Kubernetes, verify Service selector, EndpointSlice, readiness, and targetPort.
- Treat firewall reject and firewall drop as different behaviors.
- Test each resolved backend IP when failures are intermittent.

## References

- [Linux `connect(2)` manual: `ECONNREFUSED`](https://www.man7.org/linux/man-pages/man2/connect.2.html)
- [Docker documentation: publishing and exposing ports](https://docs.docker.com/get-started/docker-concepts/running-containers/publishing-ports/)
- [Kubernetes documentation: Services, `port`, `targetPort`, and EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/service/)
