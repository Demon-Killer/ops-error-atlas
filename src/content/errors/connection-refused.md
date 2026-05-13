---
title: 'Why "connection refused" happens on Linux'
description: Learn what connection refused really means, how it differs from timeout failures, and which checks to run first on Linux.
slug: connection-refused
publishedAt: 2026-05-08
tags:
  - TCP
  - Linux
  - sockets
related:
  - connection-reset-by-peer
  - no-route-to-host
---

`connection refused` means the TCP connection attempt reached the target host, but no application accepted the connection on that IP and port. This usually points to a listener problem, bind address mismatch, or an active reject from a firewall or proxy.

## What it means

The network path is often good enough for the SYN packet to arrive. The failure happens because nothing is listening where the client expects, or an intermediate device rejects the connection immediately.

## Common causes

- The target service is not running.
- The service listens on `127.0.0.1` instead of the external interface.
- The port number is wrong.
- A firewall or proxy is configured to reject connections explicitly.

## How to diagnose it

Start on the server side. `Connection refused` is usually easier to diagnose than a timeout because it is more immediate and specific.

1. Confirm the service is running.
2. Check which IP and port the service is listening on.
3. Compare the expected port with the real bind port.
4. Inspect local firewall rules if the service appears healthy.

## Commands to try

```bash
ss -ltnp
systemctl status your-service
iptables -L -n
lsof -i :<port>
```

## How to fix it

Start the missing service, correct the bind address, or point the client to the right host and port. If a firewall is rejecting the traffic, align the rule set with the intended exposure of the service.

## FAQ

### Is connection refused a DNS problem?

Usually no. DNS might point you to the wrong host, but the refusal itself means the target system answered the connection attempt.

### Is this the same as timeout?

No. A refusal is immediate. A timeout usually means packets were dropped or the remote side never responded in time.

## Short checklist

- Confirm the process is running
- Check the bind address and port
- Compare expected and actual listener settings
