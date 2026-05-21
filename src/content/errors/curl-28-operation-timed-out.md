---
title: 'How to diagnose "curl: (28) operation timed out"'
description: A practical curl error 28 guide that breaks timeout failures into DNS, TCP connect, TLS handshake, first byte, response body, and upstream application latency.
slug: curl-28-operation-timed-out
publishedAt: 2026-05-11
updatedAt: 2026-05-21
tags:
  - curl
  - timeout
  - HTTP
related:
  - nginx-upstream-timed-out
  - tls-handshake-failure
  - high-network-latency
  - dns-server-unreachable
popular: true
---

`curl: (28) operation timed out` means curl reached a configured timeout condition before the transfer completed. The error code tells you that a timeout happened. It does not tell you which phase was slow.

The useful investigation is not "curl timed out, should I increase the timeout?" The useful investigation is:

```text
Which phase consumed the budget, and which system owns that phase?
```

For an HTTPS request, the practical path is:

```text
DNS lookup
  -> TCP connect
  -> TLS handshake
  -> request write
  -> first response byte
  -> response body transfer
```

Each phase has different evidence and different fixes. A DNS delay is not fixed in Nginx. A slow first byte is not proved by `ping`. A slow body transfer is not the same as a connect timeout.

## A realistic incident shape

This is an example scenario, not a benchmark or universal timing target.

An API client reports:

```text
curl: (28) Operation timed out after 10000 milliseconds with 0 bytes received
```

The first wrong move is to raise `--max-time` from 10 seconds to 60 seconds. That may make the command wait longer, but it does not explain whether the time was spent in DNS, TCP, TLS, the upstream application, or the response body.

The better first move is to collect a phase timeline:

```bash
curl -sS -o /dev/null \
  -w 'remote_ip=%{remote_ip} dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
  https://api.example.com/health
```

The curl manual defines these timing fields as cumulative seconds from the start of the transfer:

| Field | What curl measures | First suspect when high |
| --- | --- | --- |
| `time_namelookup` | time until name resolution completed | resolver, DNS search path, service discovery |
| `time_connect` | time until TCP connect completed | routing, firewall, listener, packet loss |
| `time_appconnect` | time until SSL/SSH/etc handshake completed | TLS, SNI, certificate chain, proxy TLS termination |
| `time_starttransfer` | time until first byte was received | upstream processing, proxy queueing, dependency latency |
| `time_total` | full operation duration | total request budget, body transfer, retries, redirects |

Important detail: these fields are cumulative. For example, `time_starttransfer` includes the earlier DNS, connect, TLS, and pre-transfer work. Do not add all timing fields together as if they were independent durations.

## Know which curl timeout fired

curl has more than one timeout-related option.

| Option | Scope | What it is good for |
| --- | --- | --- |
| `--connect-timeout <seconds>` | connection phase only | proving DNS/TCP/TLS setup is too slow |
| `--max-time <seconds>` | whole transfer | bounding the full request |
| `--speed-limit <bytes>` with `--speed-time <seconds>` | transfer progress | detecting a response body that stops making progress |

According to the curl manual, `--connect-timeout` limits the connection phase, which is complete after DNS lookup and the requested TCP, TLS, or QUIC handshakes are done. `--max-time` limits each transfer as a whole. `--speed-time` and `--speed-limit` abort a transfer when transfer speed stays below the configured threshold for the configured period.

That distinction matters. A command like this:

```bash
curl --max-time 10 https://api.example.com/report
```

can fail because DNS was slow, TCP connect was slow, TLS was slow, the server took too long to send the first byte, or the response body did not finish. The exit code alone does not separate those cases.

## First diagnostic command

Use this before changing application or proxy settings:

```bash
curl -sS -o /dev/null \
  --connect-timeout 3 \
  --max-time 10 \
  -w 'remote_ip=%{remote_ip} http=%{http_code} dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n' \
  https://api.example.com/path
```

Use your own timeout values. The `3` and `10` above are example budgets for a quick diagnostic command, not universal production defaults.

Interpretation:

| Observation | What to do next |
| --- | --- |
| `dns` is high | test the resolver directly and compare from the failing host |
| `connect` is high while DNS is low | inspect route, firewall, listener health, SYN retransmits |
| `tls` is high or fails | inspect SNI, certificate chain, TLS termination, proxy path |
| `first_byte` is high while connect/TLS are low | inspect upstream logs, proxy queueing, DB/cache/API latency |
| `total` is high but `first_byte` is normal | inspect response size, streaming, slow client path, transfer stalls |
| `remote_ip` changes between slow and fast runs | test each backend IP separately |

## Repeat the test before trusting one sample

One curl run is a snapshot. It is not enough evidence for intermittent failures.

```bash
for i in $(seq 1 10); do
  date -Is
  curl -sS -o /dev/null \
    --connect-timeout 3 \
    --max-time 10 \
    -w "$i remote_ip=%{remote_ip} http=%{http_code} dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}\n" \
    https://api.example.com/path
done
```

Look for patterns:

- one `remote_ip` is consistently slower;
- slow runs happen in bursts;
- DNS time spikes before connect time;
- first-byte time rises while connect and TLS stay stable;
- total time rises only on large responses.

Those are observations, not final proof. Use them to choose the next system to inspect.

## Test one resolved IP without breaking SNI

If DNS returns multiple addresses, do not test only the hostname and do not test only the raw IP. A raw-IP test can change the `Host` header, SNI, certificate verification, and virtual-host routing.

Use `--resolve`:

```bash
curl -v \
  --resolve api.example.com:443:203.0.113.10 \
  https://api.example.com/path
```

The curl manual describes `--resolve` as providing a custom address for a specific host and port pair. This keeps the URL hostname while forcing curl to connect to the chosen IP.

Use this when you suspect:

- one load-balanced target is unhealthy;
- DNS rotation sends clients to different paths;
- a specific edge, node, or region is bad;
- public and private DNS return different answers.

## Use verbose mode for protocol-level clues

```bash
curl -v https://api.example.com/path
```

Verbose output is useful for:

- which IP curl connected to;
- whether IPv6 or IPv4 was used;
- whether a proxy is involved;
- TLS protocol and certificate details;
- HTTP response headers;
- whether the connection is reused in that curl invocation.

Do not paste secrets from verbose output into tickets or public issues. Headers can contain credentials, cookies, bearer tokens, or internal hostnames.

## When DNS time is high

Start by identifying the resolver used by the failing environment:

```bash
cat /etc/resolv.conf
resolvectl status
```

In a container or pod, run the command inside the same namespace:

```bash
docker exec -it <container> cat /etc/resolv.conf
kubectl exec -it <pod> -- cat /etc/resolv.conf
```

Then query the resolver directly:

```bash
dig @<resolver-ip> api.example.com +time=2 +tries=1
dig @<resolver-ip> api.example.com +tcp +time=2 +tries=1
```

If public names work but private names fail, check private DNS zones, VPN or VPC resolver reachability, split-horizon DNS, and search domains. Do not replace an internal resolver with a public resolver if the service depends on private names.

## When TCP connect time is high

If DNS is quick but connect time is high, inspect the path to the selected IP:

```bash
ip route get <remote-ip>
nc -vz <remote-ip> 443
mtr -rw <remote-ip>
```

On the server side, check whether a listener exists and whether the host is under pressure:

```bash
ss -ltnp
ss -s
netstat -s | grep -Ei 'listen|retrans|timeout|reset'
```

Evidence to collect:

- selected source IP and destination IP;
- whether the same IP is slow from another source;
- SYN retransmissions in packet capture;
- firewall or security-group changes;
- listener backlog or accept queue symptoms;
- whether only IPv6 or only IPv4 is affected.

Do not treat connect timeout as an application-handler problem until you prove the request reached the application.

## When TLS time is high or TLS fails

Use `openssl` with SNI:

```bash
openssl s_client -connect api.example.com:443 -servername api.example.com -showcerts
```

Then compare with curl:

```bash
curl -v https://api.example.com/path
```

Check:

- SNI hostname;
- certificate chain;
- certificate expiration and SANs;
- TLS termination point;
- mTLS requirement;
- corporate or service-mesh interception;
- runtime-specific trust store if the app fails but curl works.

Do not use `curl -k` as a fix. It is a diagnostic shortcut that disables certificate verification for that command.

## When first byte is slow

If DNS, connect, and TLS are low but `time_starttransfer` is high, curl has usually reached the server path and is waiting for the first response byte.

At that point, inspect server-side timing. For Nginx, add or check access-log fields like:

```nginx
log_format upstream_time '$remote_addr "$request" $status '
                         'rt=$request_time '
                         'uct=$upstream_connect_time '
                         'uht=$upstream_header_time '
                         'urt=$upstream_response_time '
                         'upstream=$upstream_addr';
```

NGINX documentation defines:

- `$upstream_connect_time`: time spent establishing a connection with an upstream server;
- `$upstream_header_time`: time between upstream connection and first byte of upstream response header;
- `$upstream_response_time`: time between upstream connection and last byte of upstream response body;
- `$request_time`: total time spent processing the request.

All of those values are measured in seconds with millisecond resolution.

Compare curl's `time_starttransfer` with:

- Nginx `$request_time`;
- Nginx `$upstream_header_time`;
- application handler duration;
- database/cache/downstream API timings;
- queue time before the request reaches a worker.

If curl times out but the application has no request log, the failure may be before the app: routing, proxy, load balancer, TLS termination, or connection setup. If the application logs a long handler time, the timeout is likely exposing upstream work or dependency latency.

## When total time is high but first byte is normal

This means the response started, but the full operation did not finish quickly enough.

Check:

- response size;
- streaming gaps;
- compression behavior;
- proxy buffering;
- slow client or network path;
- whether the server keeps writing after the client gives up.

Use curl's speed controls when the symptom is a stalled transfer:

```bash
curl -v \
  --speed-limit 1024 \
  --speed-time 10 \
  https://api.example.com/large-response
```

The numbers above are diagnostic examples. Choose thresholds that make sense for the response type you are testing.

## Timeout budgets: do not set every layer to the same value

A production request often crosses multiple deadlines:

```text
external client timeout
  > edge or load balancer timeout
  > reverse proxy timeout
  > application handler deadline
  > dependency deadline
```

This is a design principle, not a universal formula. The outer caller should not abandon the request while inner systems continue expensive work for much longer. The inner dependency calls should usually fail early enough for the application to return a controlled error.

Illustrative bad pattern:

```text
client: 10s
proxy: 60s
app dependency call: 60s
database query: no clear deadline
```

Those values are examples, not recommended defaults. The point is the shape: curl may report a timeout while the server continues doing work that cannot be returned to the caller.

Better pattern:

```text
client-facing budget is explicit
application logs per-dependency timing
dependency deadlines fit inside the request budget
retries are bounded by one total deadline
```

Do not add retries without a total deadline. Repeating the same slow request can amplify an overload.

## Decision tree

Use this sequence during an incident:

```text
1. Capture curl timing fields.
2. Repeat enough times to see whether the pattern is stable.
3. Record remote_ip for each run.
4. If DNS is high, inspect resolver path from the failing runtime.
5. If connect is high, inspect route, firewall, listener, and packet loss.
6. If TLS is high or fails, inspect SNI, chain, trust, and termination point.
7. If first byte is high, inspect proxy and upstream application timing.
8. If total is high after first byte, inspect response body transfer and streaming.
9. Only then change timeout values.
```

## What not to do

- Do not immediately increase `--max-time` without locating the slow phase.
- Do not assume curl error 28 always means a network problem.
- Do not test only from your laptop if the production caller runs in a container, pod, VPC, or private subnet.
- Do not test a raw IP without preserving the hostname when SNI or virtual hosts are involved.
- Do not treat a single curl sample as proof of an intermittent issue.
- Do not retry unsafe HTTP methods without idempotency controls.
- Do not disable TLS verification as a production fix.

## Incident note template

Use this when escalating:

```text
symptom:
curl command:
timestamp and timezone:
source host / pod / region:
destination hostname:
remote_ip from curl:
http_code:
time_namelookup:
time_connect:
time_appconnect:
time_starttransfer:
time_total:
server request id:
Nginx request_time:
Nginx upstream_connect_time:
Nginx upstream_header_time:
Nginx upstream_response_time:
application handler timing:
dependency timing:
packet loss / retransmission evidence:
recent deploy or config change:
```

This makes the ticket actionable. It separates what was measured from what is suspected.

## Short checklist

- Use curl timing fields before changing timeout values.
- Remember that curl timing fields are cumulative from the start of the transfer.
- Record `remote_ip` and test individual targets with `--resolve` when load balancing is involved.
- Compare client timing with Nginx and application timing.
- Treat DNS, connect, TLS, first byte, and body transfer as separate failure phases.
- Mark example numbers as examples; use measured values from your system for conclusions.

## References

- [curl man page: `--write-out`, timing fields, `--connect-timeout`, `--max-time`, `--resolve`, and speed limits](https://curl.se/docs/manpage.html)
- [NGINX documentation: access log timing variables](https://docs.nginx.com/nginx/admin-guide/monitoring/logging/)
