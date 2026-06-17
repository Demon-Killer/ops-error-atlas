---
title: 'How to fix Nginx "host not found in upstream"'
description: A practical Nginx host not found in upstream guide that separates startup DNS resolution, resolver directive behavior, Docker and Kubernetes DNS, variable proxy_pass, and upstream name changes.
slug: nginx-host-not-found-in-upstream
publishedAt: 2026-06-17
updatedAt: 2026-06-17
tags:
  - Nginx
  - DNS
  - reverse-proxy
related:
  - dns-server-unreachable
  - temporary-failure-in-name-resolution
  - nginx-502-bad-gateway
  - nginx-upstream-timed-out
---

`host not found in upstream` means Nginx could not resolve an upstream hostname when it needed that name. It commonly appears during config test, reload, container startup, or request handling with variable-based proxy targets.

The useful question is:

```text
Did Nginx need this upstream name resolved at startup, reload time, or request time?
```

That timing matters because Nginx hostname resolution behavior depends on how the upstream is configured.

## Common examples

You may see:

```text
nginx: [emerg] host not found in upstream "api" in /etc/nginx/conf.d/default.conf:12
```

or:

```text
no resolver defined to resolve api.internal
```

or a runtime upstream failure when a variable is used in `proxy_pass`.

These are related but not identical. One fails at startup or reload; another fails during request processing.

## First inspect the exact config

Dump the effective config:

```bash
nginx -T
```

Find upstream references:

```bash
nginx -T | grep -nE 'upstream|proxy_pass|resolver'
```

Then test DNS from the same environment as Nginx:

```bash
getent hosts api
getent hosts api.internal
cat /etc/resolv.conf
```

If Nginx runs inside Docker or Kubernetes, run those commands inside the Nginx container or pod, not on the host.

## Startup resolution vs request-time resolution

Static upstream hostnames are often resolved when Nginx loads configuration:

```nginx
proxy_pass http://api:8080;
```

If `api` is not resolvable at startup, Nginx can fail to start.

Variable-based proxy targets need a resolver for request-time resolution:

```nginx
resolver 127.0.0.11 valid=30s;
set $backend api:8080;
proxy_pass http://$backend;
```

The `resolver` directive tells Nginx which DNS server to use at runtime.

## Docker branch

In Docker Compose, service names are resolved on the Compose network. Common failure causes:

- Nginx container is not on the same network as the upstream service;
- upstream service name differs from the hostname in Nginx config;
- Nginx starts before the DNS name exists;
- `localhost` is used when the upstream is another container;
- runtime resolver should be Docker's embedded DNS, often `127.0.0.11`.

Checks:

```bash
docker ps
docker inspect <nginx-container>
docker exec -it <nginx-container> cat /etc/resolv.conf
docker exec -it <nginx-container> getent hosts api
docker exec -it <nginx-container> nginx -T
```

Fix path:

- put Nginx and upstream on the same Docker network;
- use the Compose service name, not host-only names;
- avoid `localhost` for another container;
- configure a runtime resolver when variable `proxy_pass` is required.

## Kubernetes branch

In Kubernetes, prefer stable Service DNS names:

```text
service-name.namespace.svc.cluster.local
```

Checks:

```bash
kubectl exec -it <nginx-pod> -- cat /etc/resolv.conf
kubectl exec -it <nginx-pod> -- getent hosts api.default.svc.cluster.local
kubectl get svc,endpointslices -o wide
```

Common causes:

- Service name or namespace is wrong;
- Nginx pod DNS policy is unexpected;
- CoreDNS is unhealthy;
- NetworkPolicy blocks DNS;
- Nginx config uses a short name that resolves differently than expected;
- the upstream name exists, but has no ready endpoints, which is a later routing problem.

If DNS resolves but requests still fail, move from `host not found` to upstream connection, 502, or timeout debugging.

## `resolver` directive branch

Runtime DNS resolution needs a resolver:

```nginx
resolver 10.96.0.10 valid=30s ipv6=off;
```

Common mistakes:

- no `resolver` directive with variable `proxy_pass`;
- resolver IP works on the host but not inside the container;
- resolver points to public DNS for private service names;
- IPv6 queries are attempted when the environment has no IPv6 path;
- resolver cache `valid` hides recent changes longer than expected.

Use the resolver that is reachable from the Nginx worker environment.

## Case: name works in shell but Nginx still fails

Possible reasons:

- the shell test was on the host, but Nginx runs in a container;
- `/etc/hosts` differs between shell and Nginx worker environment;
- Nginx resolves at config load before the name exists;
- systemd service starts before network or DNS is ready;
- Nginx uses its own configured resolver for variable upstreams.

Check the exact process environment and startup order:

```bash
systemctl status nginx
journalctl -u nginx --since -30m
nginx -t
```

## What not to do

- Do not replace internal service DNS with public DNS.
- Do not use `localhost` for another container or pod.
- Do not assume host DNS success proves Nginx DNS success.
- Do not add a `resolver` directive without testing that resolver from the Nginx environment.
- Do not mix static upstream behavior and variable `proxy_pass` behavior.

## Decision tree

```text
host not found in upstream
|
+-- fails during nginx -t or startup?
|   +-- inspect static proxy_pass/upstream hostname and startup DNS
|
+-- fails at request time?
|   +-- inspect variable proxy_pass and resolver directive
|
+-- Docker?
|   +-- check container network, service name, 127.0.0.11
|
+-- Kubernetes?
|   +-- check Service DNS, namespace, CoreDNS, NetworkPolicy
|
+-- name resolves but upstream still fails?
    +-- debug 502, connect refused, connect timed out, or upstream timed out
```

## Minimal incident note

```text
error line:
nginx config line:
static upstream or variable proxy_pass:
nginx runtime environment:
/etc/resolv.conf in nginx environment:
resolver directive:
getent hosts result:
Docker/Kubernetes service name:
startup or request-time failure:
fix:
nginx -t result:
verification request:
```

The incident is solved when Nginx can resolve the intended upstream name at the time it needs it and the next failure, if any, moves to a concrete connection or upstream response phase.

## References

- [Nginx proxy module documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [Nginx core `resolver` directive](https://nginx.org/en/docs/http/ngx_http_core_module.html#resolver)
- [Docker networking overview](https://docs.docker.com/engine/network/)
- [Kubernetes DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
