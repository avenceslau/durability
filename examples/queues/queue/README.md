# Partitioned FIFO queue

A queue service on Durable Objects, built from the [`durability`](https://github.com/avenceslau/durability) primitives. It is one of the three Workers of the [`queues` example](../README.md): [`push_consumer`](../push_consumer) uses it, and [`loadgen`](../loadgen) loads it.

- **Ordered per key.** Messages that share a key reach each target in the order they were accepted. A retried message holds back only the later messages of its key.
- **Consumers like Cloudflare Queues.** A Worker extends `QueueEntrypoint`, implements `queue(batch)`, and acknowledges or retries each message.
- **Many in, many out.** Any number of producers; every target of a queue receives every message, at its own pace, with its own retries and dead letters.
- **Autoscaling.** Partitions are added and removed, up to 10,000 per queue, with what is sent to the queue and the backlog, without breaking order. Queues, targets, and limits are created at runtime: nothing is redeployed.
- **Push or pull.** Targets are called with each batch. Turn pull consumers on and every message is also kept in R2, for up to 50 days, for consumers that ask for messages instead.
- **Limits.** Messages per batch and per second per partition, and batches in flight across the whole queue.
- **Dashboard.** Accepted and delivered messages per second over the last 30 minutes, backlog, in-flight work, retries, dead letters, partitions, and scaling events, live over a WebSocket. With the [load generator](../loadgen) deployed, it also starts and watches load tests.

Other Workers use the queue through two service binding entrypoints. `QueueBinding` sends, pulls, and redrives. `QueueAdmin` creates and configures queues; it is separate so that a Worker bound only to produce cannot reconfigure a queue. An HTTP API serves the dashboard and clients that are not Workers.

## Send

```jsonc
// The producer's wrangler.jsonc
"services": [{ "binding": "QUEUE", "service": "fifo-queue", "entrypoint": "QueueBinding" }]
```

```ts
import type { QueueBinding } from '@queues-example/queue';

type Env = { QUEUE: Service<QueueBinding> };

const outcome = await env.QUEUE.send('orders', {
  key: 'customer-42',
  messages: [{ body: { total: 12 } }, { body: { total: 7 } }],
});
// { accepted: true, ids: ['…', '…'] }
// or { accepted: false, error: { name: 'Backpressure', message: '…' } }
```

`send` takes one key and up to 1000 messages for it: `{ key: string, messages: { body: unknown, id?: string }[] }`. A message without an `id` gets a random one.

**A send has one key.** The key decides the partition, so a send goes to one partition, which stores all of its messages or none. Messages of several keys are several sends. A send whose messages were spread over the queue's partitions would call most of them for one message each, and a partition can answer far fewer calls than it can store messages.

The outcome is either accepted, with the ids in order, or rejected, with the reason:

- **Accepted** means stored. Delivery happens afterwards.
- **`Backpressure`**: the partition cannot keep up (too much is waiting for it in the Worker, or a call waited over two seconds before the partition got to it), or the queue sets `maxBacklog` and a running target is that far behind. Retry later. What is refused counts as demand, so the queue adds partitions.
- **`PartitionReplaced`** after three redirects: the queue is resizing. Retry shortly.
- **A thrown call** is uncertain: the messages may or may not be stored. Retry **with the same `id`s**. A partition accepts an id once while it keeps the message, so only a retry that lands after a resize can store a message twice.

## Consume over RPC

A consumer is a class in another Worker that extends `QueueEntrypoint`:

```ts
import {
  QueueEntrypoint,
  type MessageBatch,
} from '@queues-example/queue/consumer';

type Order = {
  customer: string;
  total: number;
};

export class Orders extends QueueEntrypoint<Env, Order> {
  async queue(batch: MessageBatch<Order>): Promise<void> {
    for (const message of batch.messages) {
      await charge(message.body);
      message.ack();
    }
  }
}
```

`@queues-example/queue/consumer` depends only on the Workers runtime. `this.env` and `this.ctx` are available as on `WorkerEntrypoint`.

The queue reaches the class through a service binding in **its own** `wrangler.jsonc`, and a target names that binding:

```jsonc
// This Worker's wrangler.jsonc
"services": [{ "binding": "ORDERS", "service": "push-consumer", "entrypoint": "Orders" }]
```

```ts
await env.QUEUE_ADMIN.putTarget('orders', 'billing', {
  destination: { type: 'rpc', binding: 'ORDERS' },
});
```

A `Message` has `id` (the same on every delivery), `key`, `timestamp`, `body`, `attempts` (1 on the first delivery), `ack()`, and `retry({ delaySeconds })`. A `MessageBatch` has `queue`, `messages`, `ackAll()`, and `retryAll({ delaySeconds })`.

The queue makes one RPC call per batch, `deliverQueueBatch`, which the base class owns: it builds the batch, runs `queue()`, and returns which messages were acknowledged and which retried. The rules follow Cloudflare Queues:

- The first `ack()` or `retry()` on a message wins.
- A call on a message beats `ackAll()` and `retryAll()`; the first of those two wins.
- When `queue()` returns, messages it left alone are acknowledged.
- When `queue()` throws, messages that were not acknowledged, individually or by `ackAll()`, are retried.

A retried message is delivered again after its `delaySeconds`, or the target's `retryDelaySeconds`. Either is at most a day; a delay that is not a number of seconds from zero up is ignored. After `maxRetries` retries it is written to the dead letters.

Delivery is **at least once**. A message is delivered again after a retry, a timeout, or a crash of the partition mid-delivery, so the work must be safe to repeat for the same `id`. An RPC call cannot be cancelled: after the target's `attemptTimeoutMs` the batch is retried while the consumer may still be running it.

### Order

Order is kept per key, per target:

- **A retried message holds back its key.** Later messages with the same key wait, for that target, until it is acknowledged or dead-lettered. Messages with other keys keep flowing, and other targets are not affected.
- **Later messages of the key in the same batch go again.** Once a message of a key is retried, the later messages of that key in the batch are delivered again after it, whatever the consumer decided for them. That delivery does not count against their retries. A consumer that acknowledged one of them sees it again, so stop working on a key at its first failure, as [`push_consumer`](../push_consumer/src/index.ts) does.
- **Dead letters and redrives leave the order.** A dead-lettered message frees the messages behind it, and a redriven message arrives after whatever its key received since.

## Targets

| Destination                         | Delivery                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `{ type: 'rpc', binding }`          | One call to a class extending `QueueEntrypoint`, through a service binding in `wrangler.jsonc`.                  |
| `{ type: 'webhook', url, secret? }` | `POST` of the batch as JSON. With a secret, `X-Queue-Signature: sha256=<hex HMAC of the body>`.                  |
| `{ type: 'service', binding }`      | The same `POST`, to a service binding's `fetch`.                                                                 |
| `{ type: 'queue', queue }`          | Into another queue of this deployment, keeping keys. A message is acknowledged once the other queue accepted it. |
| `{ type: 'archive' }`               | Each batch as one object under `archive/` in the `STORAGE` bucket.                                               |

Adding an `rpc` or `service` target for a new Worker needs a binding, and so a redeploy of the queue.

A `POST`ed batch looks like this:

```json
{
  "queue": "orders",
  "target": "billing",
  "partition": "orders/3/1",
  "messages": [
    {
      "id": "…",
      "key": "customer-42",
      "offset": 17,
      "body": { "total": 12 },
      "sentAt": 1767225600000,
      "attempts": 1
    }
  ]
}
```

A `2xx` answer acknowledges every message, except those its JSON body lists under `retried`, by id or with a delay: `{ "retried": ["…", { "id": "…", "delaySeconds": 30 }] }`. A bare `2xx` acknowledges them all. Any other answer, or no answer within the timeout, retries them all; `Retry-After` is the delay. There is no batch-level idempotency header: deduplicate on each message's `id`.

Target settings:

| Setting             | Default    | Meaning                                                                                                       |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `maxBatchSize`      | 10         | Messages one partition hands the target at a time, 1 to 100.                                                  |
| `maxRetries`        | 3          | Retries before a message is dead-lettered, so up to four deliveries.                                          |
| `retryDelaySeconds` | 0          | Delay before a retried message is delivered again, unless the consumer gives one.                             |
| `maxConcurrency`    | none       | Batches in flight for this target across the queue. Needs the queue's own `maxConcurrency`.                   |
| `maxPerSecond`      | none       | Messages per second one partition hands the target.                                                           |
| `attemptTimeoutMs`  | 10000      | How long one delivery may take, 100 to 30000.                                                                 |
| `paused`            | `false`    | A paused target receives nothing and keeps its place.                                                         |
| `startAt`           | `'latest'` | Where a target added to an existing queue starts: `'latest'`, or `'earliest'` for what partitions still hold. |

With the default `retryDelaySeconds` of 0, a consumer that keeps failing without asking for a delay uses up its retries quickly.

## Pull consumers

A target is called with each batch. A pull consumer asks instead. Set `pullConsumers` on a queue and it gets a target of its own, `pull`, that writes every batch to the `PULL` R2 bucket. Consumers read from there, through a Durable Object per consumer, so pulling takes nothing from the partitions.

```ts
await env.QUEUE_ADMIN.updateSettings('orders', { pullConsumers: true });

const batch = await env.QUEUE.pull('orders', 'reports');
if (batch) {
  await handle(batch.messages);
  await env.QUEUE.ack('orders', 'reports', batch.lease);
}
```

- **A consumer is a name.** Each name has its own position, so `reports` and `search` both receive every message. Several processes may pull under one name: they share its messages.
- **Order.** One pull returns consecutive messages of one partition, and that partition hands the consumer nothing else until they are acknowledged, given back with `nack`, or the lease ends (`visibilityMs`, 30 seconds by default). Keys therefore stay in order, also across a resize; different partitions are pulled in parallel.
- **At least once.** A lease that ends is handed out again with a higher `attempt`. Acknowledging the old lease then returns `false`.
- **Size.** `batches` is how many stored batches one pull may return, 10 by default and at most 100, each up to 100 messages.
- **Retention.** `pullRetentionDays` (1 to 50, default 7) is how long a message can be pulled. Each partition deletes its batches when that time is over. Retention does not wait for consumers, and a slow pull consumer does not cause backpressure: one that falls further behind than the retention misses messages. A new consumer name starts at the oldest message still stored.

## Redrive

A redrive replays dead letters through the queue. Each message goes only to the target that gave up on it, with a fresh set of retries, and its dead letter is deleted once the queue accepted it.

```ts
// One target's dead letters; leave the target out for every target's.
await env.QUEUE.redrive('orders', 'billing');
const status = await env.QUEUE.redriveStatus('orders');
// { running: false, startedAt: …, finishedAt: …, redriven: 240, left: 0 }
```

The call starts a job and returns at once. The job runs in its own Durable Object, the `Redriver`, one page of 100 dead letters per alarm run, so a large set takes nothing from the partitions or the orchestrator and is not bound by one request's limits.

`redriven` counts messages accepted back; `left` counts messages in dead letters the queue refused (backpressure), which stay for the next redrive. One redrive runs per queue at a time: a call made during a run reports that run and starts nothing. Dead letters written while a redrive runs wait for the next one, and those of a target that was removed are left in R2. Redriven messages keep their `id` but are stored as new messages: order does not cover them.

## A queue without targets

Messages a queue accepts while it has no target at all are written straight to the dead letters, rather than left in the partitions until retention removes them. A redrive of the whole queue delivers them to every target the queue has by then. Pull consumers count as a target.

## Administer

```jsonc
// The admin Worker's wrangler.jsonc
"services": [{ "binding": "QUEUE_ADMIN", "service": "fifo-queue", "entrypoint": "QueueAdmin" }]
```

```ts
import type { QueueAdmin } from '@queues-example/queue';

type Env = { QUEUE_ADMIN: Service<QueueAdmin> };

await env.QUEUE_ADMIN.create('orders', {
  partitions: { min: 1, max: 16 },
  maxConcurrency: 50,
});
await env.QUEUE_ADMIN.putTarget('orders', 'billing', {
  destination: { type: 'rpc', binding: 'ORDERS' },
  maxBatchSize: 20,
  retryDelaySeconds: 5,
});
await env.QUEUE_ADMIN.updateSettings('orders', { maxBacklog: 50_000 });
const overview = await env.QUEUE_ADMIN.overview('orders');
```

| Method                               | Does                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `list()`                             | The queues, for the dashboard.                                                                  |
| `create(queue, settings?, targets?)` | Creates a queue, with targets by name if given. Give them here when sends follow at once.       |
| `updateSettings(queue, changes)`     | Changes the settings given and keeps the rest, `partitions` included.                           |
| `putTarget(queue, target, settings)` | Adds or replaces a target. Settings left out take their defaults.                               |
| `pauseTarget(queue, target, paused)` | Pauses or resumes a target.                                                                     |
| `removeTarget(queue, target)`        | Removes a target.                                                                               |
| `resize(queue, partitions)`          | Starts a resize, within `partitions.min` and `max`. It does not wait for earlier ones to drain. |
| `overview(queue)`                    | Settings, targets, epochs, the latest sample of each partition, limiters, and points.           |
| `delete(queue)`                      | Deletes the queue.                                                                              |

Queue settings: `partitions` (`min` 1, `max` 16, each up to 1000; `targetRate` 200 messages per second per partition), `maxConcurrency` (batches in flight across the queue, `null` for no limit), `limitMode` (`strict` or `fast`), `limiterTargetRate` (200 permit requests per second per limiter), `maxBacklog` (undelivered messages per partition before sends are refused; `null`, the default, for no limit), `pullConsumers`, and `pullRetentionDays`.

### HTTP

Clients that are not Workers send and pull over HTTP with bearer tokens, set as secrets: `PRODUCER_TOKEN` and `CONSUMER_TOKEN`.

The dashboard and the admin API under `/api` have **no sign-in of their own**. Anyone who can reach the Worker can create, reconfigure, and delete queues, so put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of it before you deploy; Access then decides who gets in, and the dashboard needs nothing more. The only check the Worker makes is that a request naming an origin names its own, so another site cannot act through a signed-in browser.

| Route                                              | Token    | Does                                                                                                      |
| -------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `POST /queues/<queue>/messages`                    | producer | `send`, with `{ key, messages }`. `202` when accepted, `429` on backpressure, `503` for other rejections. |
| `POST /queues/<queue>/consumers/<consumer>/pull`   | consumer | `pull`, with `{ batches?, visibilityMs? }`. `null` when caught up.                                        |
| `POST /queues/<queue>/consumers/<consumer>/ack`    | consumer | `ack` with `{ lease }`. `409` when the lease is no longer current. `nack` is the same.                    |
| `GET`, `POST /api/queues`                          | none     | `list`; `create` with `{ name, settings? }`.                                                              |
| `GET`, `PATCH`, `DELETE /api/queues/<queue>`       | none     | `overview`, `updateSettings`, `delete`.                                                                   |
| `PUT`, `DELETE /api/queues/<queue>/targets/<name>` | none     | `putTarget`, `removeTarget`.                                                                              |
| `POST /api/queues/<queue>/targets/<name>/pause`    | none     | `pauseTarget` with `{ paused }`.                                                                          |
| `POST /api/queues/<queue>/resize`                  | none     | `resize` with `{ partitions }`.                                                                           |
| `POST`, `GET /api/queues/<queue>/redrive`          | none     | `redrive` of the queue, `redriveStatus`. `POST …/targets/<name>/redrive` for one target.                  |

`scripts/load.mjs` sends a steady stream over HTTP, which is the quickest way to watch the dashboard and the autoscaler:

```sh
PRODUCER_TOKEN=... node scripts/load.mjs https://fifo-queue.<subdomain>.workers.dev orders --rate 200 --keys 50 --seconds 120
```

With Cloudflare Access in front of the Worker, also set `CF_ACCESS_TOKEN="$(cloudflared access token -app=https://fifo-queue.<subdomain>.workers.dev)"`.

## How it works

The [architecture guide](https://durability.shirei.dev/compositions/fifo-queue/) steps through a send, a delivery, a redrive, pull consumers, a resize, the concurrency limit, and the metrics against this source.

```
 producers ──► Worker ──hash(key)──► Partition (N per queue) ──► targets
                 ▲                       │   ▲
       KV: partition list         permits│   │config, shares
                 │                       ▼   │
            Orchestrator ◄── samples ── Limiter (L per queue)
            (1 per queue) ──► dashboard (WebSocket)
```

| Piece                                 | Role                                                                                                                                                      | Primitives                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Worker (`src/index.ts`, `send.ts`)    | The entrypoints and the HTTP API. Reads the queue's partition list from KV, hashes each key to a partition, appends.                                      | `DurabilityTopology.client`, `DurabilityRouting.client`                             |
| `Partition`                           | An ordered log. Accepts messages; hands each target its next batch and tracks each message until the target settles it.                                   | `DurabilityLog`, `DurabilityAlarms`, `DurabilityOutbox`, `DurabilitySemaphoreQueue` |
| `Limiter`                             | Holds a share of the queue's concurrency limit and hands out permits.                                                                                     | `DurabilitySemaphore`                                                               |
| `Orchestrator`                        | Control plane: owns the partition and limiter sets, pushes configuration, autoscales, stores metrics, serves the dashboard. No message passes through it. | `DurabilityTopology` (two instances), `DurabilityAlarms`, `DurabilitySocket`        |
| `Redriver`                            | Replays a queue's dead letters as a job, one page per alarm run, apart from delivery and the control plane.                                               | `DurabilityAlarms`                                                                  |
| `PullConsumer`                        | One per pull consumer of a queue: reads batches from the pull bucket and holds the consumer's positions and leases.                                       | SQLite storage only                                                                 |
| `QueueEntrypoint` (`src/consumer.ts`) | The consumer's base class: turns one call into a batch, runs `queue()`, and returns what was acknowledged and retried.                                    | None                                                                                |

**The partition list in KV has no expiry** and is written only by the orchestrator, when the partitions change.

**A backlog can outgrow its partition.** The partition's log (`DurabilityLog`) is given R2 as cold storage. Once the partition holds more than 512 MB, or a message turns 4 days old, the log hands over its oldest messages: those every target has received, and those too old, are dropped; the rest are written to R2 as one object per run of up to 1,000. Delivery reads through both without knowing the difference. A sweep deletes the objects every target has passed.

**A partition under too much load refuses instead of falling behind.** The Worker stamps each call with the time it made it. A partition that gets to a call more than two seconds later refuses it without touching storage, so it works through what is queued for it quickly and stays able to answer the orchestrator, report, and deliver. The Worker then leaves that partition alone for a quarter of a second, refusing its share of sends itself, and tells the partition with its next call how much it refused. Those refusals are in the partition's report, and the autoscaler counts them as demand: a queue too small for its traffic grows within seconds instead of looking quiet.

**Partitions are placed around the world.** A Durable Object starts near whoever reaches it first, and for a partition that is the orchestrator. A queue's partitions would all start in its part of the world, several to a machine, and partitions that share a machine hold each other up. Each partition is therefore given a region by its index (`partitionRegion` in `src/layout.ts`), and every caller passes the same hint. With 3,000 partitions and the same load, that took failed sends from about 10% to 2–3%. The price is distance: a send may cross the world to its partition.

**Sends are merged per partition.** A send goes to the one partition of its key, and a busy partition would be called once per send. The Worker makes one call to a partition at a time (`src/coalesce.ts`): a send that arrives while one is on its way waits, and goes together with the others that waited. The partition stores a call in one transaction, all of it or none. Nothing is held back to fill a batch, and there is no timeout: a slow partition shows as latency. What may wait is bounded instead, at 5,000 messages per partition and 100,000 per Worker isolate. Past that a send is rejected at once as backpressure (`429` over HTTP), because an isolate that kept everything a slow partition could not take would run out of memory and fail the sends that had been stored.

**Two kinds of target.** For `rpc`, `webhook`, `service`, and `queue` targets, a partition records every message it hands out in a `pending` table. An acknowledged message is deleted from it; a retried one stays, with the time it is due again, and later messages of its key are held behind it. A message handed out and not settled within the timeout plus five seconds, for example because the partition was evicted mid-call, is delivered again. The `pull` and `archive` targets store whole batches instead: one range of offsets at a time, retried with backoff before the next, so the bucket holds each partition's messages in order. A whole batch is dead-lettered after `maxRetries`; the `pull` target allows 100.

**Resizing without losing order.** A new partition count re-maps keys, so a resize starts a new _epoch_:

1. The orchestrator tells the current partitions to stop accepting, each on its own and again until it answers, because a partition under load turns calls away. A stopped partition refuses sends and answers with the new layout, so a Worker isolate holding an old partition list is redirected instead of accepted out of order. A redirect moves only the keys of the partition that gave it: until a key's own partition has stopped, another isolate can still store that key there.
2. It publishes the new partitions. They accept at once.
3. A target is delivered from the new partitions only once the old ones have nothing left for it: every message acknowledged or dead-lettered.
4. Old partitions with nothing left for any target leave the queue.

Accepting scales immediately; delivery follows when the old backlog is gone, one epoch after another. A resize does not wait for the ones before it to drain, so a queue can keep growing to accept while a slow or paused target is still working through older partitions. Each resize that has not drained keeps its partitions alive, which is why at most eight epochs are live at once.

**Growing is quick, shrinking is slow.** The autoscaler (`src/scaling.ts`) judges a queue on its last five seconds, at least doubles it when the traffic does not fit, and may grow it again ten seconds later. It halves a queue only after half an hour in which half its partitions would have carried the traffic, and half an hour after its last resize, so a queue of 4,000 partitions takes about six hours to return to one. The traffic that needed the partitions tends to come back, and every resize makes delivery wait.

**Concurrency.** With `maxConcurrency` set, a partition takes a permit from a limiter before it delivers and keeps it for up to ten seconds of continuous work. A queue starts with one limiter; the orchestrator adds limiters when their request rate exceeds `limiterTargetRate`, and splits the limit between them by demand. `limitMode` chooses how permits move between limiters:

- `strict` lowers one limiter, waits until it reports the work is done, then raises another. The limit is never exceeded.
- `fast` lowers and raises together. Permits follow demand within a couple of seconds, and the queue can run above the limit until work admitted under the old split finishes.

A target's own `maxConcurrency` is split between limiters in the same proportion, so with several limiters it is approximate.

**Metrics cost nothing per message.** A partition reports its log offset (accepted) and, for each target, its position minus the messages it has not settled (settled), about once a second while it is busy, less often as a queue passes a hundred partitions so that one orchestrator can hear them all; the orchestrator turns successive samples into rates. The same samples drive the autoscaler.

**Alarms first.** Every alarm is scheduled before the state it serves is stored, so a failure leaves nothing stored without the work that would act on it.

## Limits

- A message lives 4 days, delivered or not; `pullRetentionDays` applies to the pull bucket only. A partition holds up to 512 MB itself. When a target is further behind than that, the partition's oldest messages move to R2 under `backlog/` in the `STORAGE` bucket and are read back as delivery reaches them, so a slow or paused target costs storage and latency instead of refused sends. Set `maxBacklog` to refuse sends instead.
- One orchestrator receives every partition's samples, so the dashboard, not the queue, is what stops scaling first. Partitions report less often as their number grows, so the dashboard of a queue with thousands of them lags by tens of seconds. A queue may have 10,000 partitions; it was tried with 4,000.
- A new queue's partition list is in KV, which takes up to a minute to show it everywhere. Until then a send from another region is answered as if the queue did not exist.
- One partition stores about 12,000 small messages a second at most, and comfortably half that. Beyond it the runtime turns calls away as `Durable Object is overloaded`, which a producer sees as a thrown call, not as backpressure.
- The autoscaler's thresholds (`src/scaling.ts`) and `limiterTargetRate` are starting points, not measurements of your workload.
- A message waiting for a retry is still subject to the 4 days: retries and delays that add up to more lose it without a dead letter. The partition reports it as the target's last error.
- A delivery counts from when the partition picks the batch, as with a visibility timeout. A partition that restarts between picking a batch and calling the consumer has spent one of the message's attempts on a call that was never made, so with `maxRetries: 0` such a message goes to the dead letters undelivered.
- A removed target's position is kept: a target created again under the same name continues where the old one stopped. Its messages that were waiting for a retry are given up when it is removed.
- A target cannot change between an archive and a consumer; remove it and add it again.
- Deleting a queue stops its partitions; their stored messages expire with retention.
- The dashboard and admin API rely entirely on what stands in front of the Worker. The Worker does not verify the Access token itself, so a route to it that Access does not cover is an open admin API.
- Webhook targets call any URL an admin enters, and the dashboard shows their signing secrets to every admin.

## Develop

From the repository root:

```sh
pnpm install
cp examples/queues/queue/.dev.vars.example examples/queues/queue/.dev.vars
pnpm --filter @queues-example/queue dev        # dashboard on http://localhost:8787
pnpm --filter @queues-example/queue test       # runs in workerd through @cloudflare/vitest-pool-workers
pnpm --filter @queues-example/queue typecheck
pnpm --filter @queues-example/queue deploy
```

See the [example's README](../README.md) for running it together with `push_consumer`, and for the deploy order.
