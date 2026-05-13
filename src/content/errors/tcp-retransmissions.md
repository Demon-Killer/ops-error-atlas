---
title: What causes TCP retransmissions
description: Learn what TCP retransmissions imply about packet delivery, latency, and congestion, and how to inspect the path without guessing.
slug: tcp-retransmissions
publishedAt: 2026-05-06
tags:
  - TCP
  - networking
  - latency
related:
  - high-network-latency
  - intermittent-packet-loss
---

TCP retransmissions happen when the sender does not receive an acknowledgment for previously sent data in time. They are a symptom of delivery problems, but the real cause can be packet loss, reordering, congestion, or receiver-side delays.

## What it means

The sender believes one or more packets were not delivered successfully and sends them again. Retransmissions increase latency and can severely reduce throughput under sustained loss.

## Common causes

- Real packet loss on the network path
- Congestion or queue drops
- Receiver overload that delays acknowledgments
- Asymmetric routing or unstable links

## How to diagnose it

Do not stop at “there are retransmissions.” Identify where they begin and whether they correlate with load, one path, or one service.

1. Capture traffic on both sides when possible.
2. Check whether retransmissions cluster around peak traffic.
3. Compare network and host metrics for drops or overload.
4. Confirm whether only one direction is affected.

## Commands to try

```bash
tcpdump -nn -i any host <peer-ip>
ss -ti
ethtool -S <interface>
netstat -s | grep -i retrans
```

## How to fix it

Fix the actual loss or congestion point. That may mean reducing queue pressure, improving host tuning, fixing a bad link, or investigating an overloaded receiver that cannot keep up with the flow.

## FAQ

### Are all retransmissions bad?

No. Occasional retransmissions happen on real networks. They become a problem when they are frequent enough to affect latency or throughput.

### Can an overloaded server cause retransmissions?

Yes. If the receiver is slow to process packets or ACKs, the sender may retransmit.

## Short checklist

- Check where retransmissions start
- Correlate with load and path changes
- Inspect both the network and the hosts
