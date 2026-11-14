# Partitioned FIFO queue

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/avenceslau/durability/tree/main/templates/fifo-queue)

A queue service on Durable Objects, built from the [`durability`](https://github.com/avenceslau/durability) primitives:

- **Ordered per key.** Messages that share a key are delivered in the order they were accepted.
- **Many in, many out.** Any number of producers; every target of a queue receives every message, at its own pace, with its own retries and dead letters.
- **Autoscaling.** Partitions are added and removed with the accept rate and the backlog, without breaking order. Queues, targets, and limits are created at runtime: nothing is redeployed.
- **Push or pull.** Targets are called with each batch. Turn pull consumers on and every message is also kept in R2, for up to 50 days, for consumers that ask for messages instead.
- **Limits.** Messages in flight per partition, messages per second per partition, and batches in flight across the whole queue.
- **Dashboard.** Accepted and delivered messages per second, backlog, in-flight work, retries, dead letters, partitions, and scaling events, live over a WebSocket.

The button creates the Worker, a KV namespace, two R2 buckets, and asks for three secrets: `ADMIN_TOKEN` (dashboard and admin API), `PRODUCER_TOKEN` (sending messages), and `CONSUMER_TOKEN` (pulling messages).

## Use it

Open the Worker's URL, sign in with `ADMIN_TOKEN`, and create a queue and a target. Or use the API:

```sh
ORIGIN=https://fifo-queue.<your-subdomain>.workers.dev

# A queue that scales between 1 and 16 partitions, with at most 50 batches in flight.
curl -X POST $ORIGIN/api/queues \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{ "name": "orders", "settings": { "partitions": { "min": 1, "max": 16 }, "maxConcurrency": 50 } }'

# A webhook target. Every message of the queue is delivered to it.
curl -X PUT $ORIGIN/api/queues/orders/targets/billing \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{ "destination": { "type": "webhook", "url": "https://example.com/hook", "secret": "s3cret" }, "batchSize": 10 }'

# Send. Messages with the same key stay in order.
curl -X POST $ORIGIN/queues/orders/messages \
  -H "Authorization: Bearer $PRODUCER_TOKEN" \
  -d '[{ "key": "customer-42", "body": { "total": 12 } }, { "key": "customer-42", "body": { "total": 7 } }]'
```

`scripts/load.mjs` sends a steady stream, which is the quickest way to watch the dashboard and the autoscaler:

```sh
PRODUCER_TOKEN=... node scripts/load.mjs $ORIGIN orders --rate 200 --keys 50 --seconds 120
```

### Sending

`POST /queues/<queue>/messages` takes one message or an array of up to 1000: `{ "key": string, "body": any, "id"?: string }`.

| Status | Meaning                                                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `202`  | Every message is stored. Delivery happens afterwards.                                                                                                                               |
| `429`  | A target is too far behind (`maxBacklog`); the rejected ids are listed. Retry later.                                                                                                |
| `503`  | Some messages were rejected for another reason; the response lists which.                                                                                                           |
| `5xx`  | Unknown: the messages may or may not be stored. Retry **with the same `id`s**: a partition accepts an id once, so only a retry that lands after a resize can store a message twice. |

Other Workers can skip HTTP and the tokens by binding the `QueueBinding` entrypoint:

```jsonc
// The other Worker's wrangler.jsonc
"services": [{ "binding": "QUEUE", "service": "fifo-queue", "entrypoint": "QueueBinding" }]
```

```ts
await env.QUEUE.send('orders', [{ key: 'customer-42', body: { total: 12 } }]);

// Start replaying every dead letter of the queue, or only one target's.
await env.QUEUE.redrive('orders');
await env.QUEUE.redrive('orders', 'billing');
const status = await env.QUEUE.redriveStatus('orders');
```

### Targets

| Destination                               | Delivery                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `{ "type": "webhook", "url", "secret"? }` | `POST` of the batch as JSON. With a secret, `X-Queue-Signature: sha256=<hex HMAC of the body>`.       |
| `{ "type": "service", "binding" }`        | The same `POST`, to a service binding you add to `wrangler.jsonc`. Needs a redeploy to add a binding. |
| `{ "type": "queue", "queue" }`            | Into another queue of this deployment, keeping keys.                                                  |
| `{ "type": "archive" }`                   | Each batch as one object under `archive/` in the R2 bucket.                                           |

A batch looks like this, and carries an `Idempotency-Key` header (`<target>/<partition>/<first offset>-<last offset>`) that is the same on every redelivery:

```json
{
  "queue": "orders",
  "target": "billing",
  "partition": "orders/3/1",
  "attempt": 1,
  "messages": [
    {
      "id": "…",
      "key": "customer-42",
      "offset": 17,
      "body": { "total": 12 },
      "sentAt": 1767225600000
    }
  ]
}
```

Answer `2xx` to acknowledge the batch. Anything else is retried with backoff (`Retry-After` is honoured) up to `maxAttempts`, then the batch is written to `dead-letters/` in the R2 bucket and the target moves on. Delivery is **at least once**: make the receiver idempotent on `Idempotency-Key` or on message `id`.

Per target: `batchSize` (messages in flight per partition, default 10), `maxPerSecond` (per partition), `maxConcurrency` (batches in flight across the queue; needs the queue's own `maxConcurrency`), `maxAttempts`, `attemptTimeoutMs`, `paused`, and `startAt` (`latest` or `earliest`, for a new target).

### Pull consumers

A target is called with each batch. A pull consumer asks instead. Set `pullConsumers` on a queue (in the dashboard's settings, or `PATCH /api/queues/<queue>` with `{ "pullConsumers": true }`) and the queue gets a target of its own, `pull`, that writes every message to the second R2 bucket. Consumers read from there, through a Durable Object per consumer, so pulling takes nothing from the partitions.

```sh
# Ask for messages. The answer is null when the consumer has caught up.
curl -X POST $ORIGIN/queues/orders/consumers/reports/pull \
  -H "Authorization: Bearer $CONSUMER_TOKEN" -d '{}'
# → { "lease": "…", "partition": "orders/3/1", "attempt": 1, "expiresAt": …, "messages": [ … ] }

# Acknowledge them, or they are handed out again when the lease ends.
curl -X POST $ORIGIN/queues/orders/consumers/reports/ack \
  -H "Authorization: Bearer $CONSUMER_TOKEN" -d '{ "lease": "…" }'
```

```ts
const batch = await env.QUEUE.pull('orders', 'reports');
if (batch) {
  await handle(batch.messages);
  await env.QUEUE.ack('orders', 'reports', batch.lease);
}
```

- **A consumer is a name.** Each name has its own position, so `reports` and `search` both receive every message. Several processes may pull under one name: they share its messages.
- **Order.** One pull returns consecutive messages of one partition, and that partition hands the consumer nothing else until they are acknowledged, given back (`nack`), or the lease ends (`visibilityMs`, 30 seconds by default). Keys therefore stay in order, also across a resize; different partitions are pulled in parallel.
- **At least once.** A lease that ends is handed out again with a higher `attempt`. Acknowledging the old lease then answers `409` (`false` from the binding).
- **Size.** `batches` is how many stored batches one pull may return, 10 by default, each up to 100 messages.
- **Retention.** `pullRetentionDays` (1 to 50, default 7) is how long a message can be pulled. Each partition deletes its batches when that time is over. Retention does not wait for consumers, and a slow pull consumer does not cause backpressure: one that falls further behind than the retention misses messages. A new consumer name starts at the oldest message still stored.

### Redrive

A redrive replays dead letters through the queue. Each message goes only to the target that gave up on it, with a fresh set of attempts, and its dead letter is deleted once the queue accepted it. One call replays everything there is:

| Call                                                                    | Replays                      |
| ----------------------------------------------------------------------- | ---------------------------- |
| `env.QUEUE.redrive(queue)` or `POST /api/queues/<queue>/redrive`        | Every target's dead letters. |
| `env.QUEUE.redrive(queue, target)` or `POST …/targets/<target>/redrive` | One target's dead letters.   |

The call starts a job and returns at once. The job runs in its own Durable Object, the `Redriver`, one page of dead letters per alarm run, so a large set takes nothing from the partitions or the orchestrator and is not bound by one request's limits. `env.QUEUE.redriveStatus(queue)` or `GET /api/queues/<queue>/redrive` reports it:

```json
{
  "running": false,
  "startedAt": 1767225600000,
  "finishedAt": 1767225604000,
  "redriven": 240,
  "left": 0
}
```

Dead letters written while the queue had no target are replayed too, to every target. `redriven` counts messages accepted back; `left` counts messages the queue refused (backpressure), whose dead letters stay for the next redrive. One redrive runs per queue at a time: a call made during a run reports that run and starts nothing. Redriven messages arrive after whatever the target received since, so order does not cover them. Dead letters written while a redrive runs wait for the next one, and those of a target that was removed are left in R2.

### A queue without targets

Messages a queue accepts while it has no target at all are written straight to the dead letters, rather than left in the partitions until retention removes them. A redrive of the whole queue delivers them to every target the queue has by then. Pull consumers count as a target.

### Order and failure

Order is kept per key, per target. A partition hands a target one batch at a time, so a batch that keeps failing holds back the later messages **of that partition for that target** until it succeeds or is dead-lettered. Other targets and other partitions carry on. A dead-lettered batch is skipped, so order no longer covers its messages.

## How it works

The [architecture guide](https://durability.shirei.dev/compositions/fifo-queue/) steps through a send, a delivery, a resize, the concurrency limit, and the metrics against this source.

```
 producers ──► Worker ──hash(key)──► Partition (N per queue) ──► targets
                 ▲                       │   ▲
       KV: partition list         permits│   │config, shares
                 │                       ▼   │
            Orchestrator ◄── samples ── Limiter (L per queue)
            (1 per queue) ──► dashboard (WebSocket)
```

| Piece                              | Role                                                                                                                                                      | Primitives                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Worker (`src/index.ts`, `send.ts`) | Reads the queue's partition list from KV, hashes each key to a partition, appends.                                                                        | `DurabilityTopology.client`, `DurabilityRouting.client`                                    |
| `Partition`                        | An ordered log. Accepts messages; hands each target its next batch, in offset order.                                                                      | `DurabilityLog` leases, `DurabilityAlarms`, `DurabilityOutbox`, `DurabilitySemaphoreQueue` |
| `Limiter`                          | Holds a share of the queue's concurrency limit and hands out permits.                                                                                     | `DurabilitySemaphore`                                                                      |
| `Orchestrator`                     | Control plane: owns the partition and limiter sets, pushes configuration, autoscales, stores metrics, serves the dashboard. No message passes through it. | `DurabilityTopology` (two instances), `DurabilityAlarms`, `DurabilitySocket`               |
| `Redriver`                         | Replays a queue's dead letters as a job, one page per alarm run, apart from delivery and the control plane.                                               | `DurabilityAlarms`                                                                         |
| `PullConsumer`                     | One per pull consumer of a queue: reads batches from the pull bucket and holds the consumer's positions and leases.                                       | SQLite storage only                                                                        |

**The partition list in KV has no expiry** and is written only by the orchestrator, when the partitions change.

**Resizing without losing order.** A new partition count re-maps keys, so a resize starts a new _epoch_:

1. The orchestrator tells the current partitions to stop accepting. From then on they refuse sends and answer with the new layout, so a Worker isolate holding an old partition list is redirected instead of accepted out of order.
2. It publishes the new partitions. They accept at once.
3. A target is delivered from the new partitions only once the old ones have nothing left for it.
4. Old partitions with nothing left for any target leave the queue.

Accepting scales immediately; delivery follows when the old backlog is gone. Only one resize runs at a time, and a target that is paused or keeps failing holds the previous epoch, and so the next resize, until it has worked through that epoch's messages.

**Concurrency.** With `maxConcurrency` set, a partition takes a permit from a limiter before it delivers and keeps it for up to ten seconds of continuous work. A queue starts with one limiter; the orchestrator adds limiters when their request rate exceeds `limiterTargetRate`, and splits the limit between them by demand. `limitMode` chooses how permits move between limiters:

- `strict` lowers one limiter, waits until it reports the work is done, then raises another. The limit is never exceeded.
- `fast` lowers and raises together. Permits follow demand within a couple of seconds, and the queue can run above the limit until work admitted under the old split finishes.

A target's own `maxConcurrency` is split between limiters in the same proportion, so with several limiters it is approximate.

**Metrics cost nothing per message.** A partition reports its log offset (accepted) and each target's position (delivered) about once a second while it is busy; the orchestrator turns successive samples into rates. The same samples drive the autoscaler.

## Limits of this template

- A partition keeps messages for 4 days or 512 MB, whichever comes first; `pullRetentionDays` applies to the pull bucket only. A target that stays behind longer loses messages; `maxBacklog` rejects sends before that happens for running targets, not for paused ones.
- One orchestrator receives every partition's samples, so the dashboard, not the queue, is what stops scaling first. Lengthen `sampleIntervalMs` in `src/partition.ts` for queues with many hundreds of busy partitions.
- The autoscaler's thresholds (`src/scaling.ts`) and `limiterTargetRate` are starting points, not measurements of your workload.
- A removed target's position is kept: a target created again under the same name continues where the old one stopped.
- Deleting a queue stops its partitions; their stored messages expire with retention.
- The dashboard is protected by one shared token, kept in a cookie that is honoured only for requests from the Worker's own origin. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of it for real use.
- Webhook targets call any URL an admin enters, and the dashboard shows their signing secrets to every admin.

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev      # dashboard on http://localhost:8787
npm test         # runs in workerd through @cloudflare/vitest-pool-workers
npm run deploy
```

`durability` is pinned to an exact version because the topology, semaphore, and outbox primitives are experimental and may change in a minor release. `wrangler` is pinned to the version `@durability/transforms` declares as its peer.
