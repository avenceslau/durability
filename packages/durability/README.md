# Durability

Composable capabilities for application-owned Cloudflare Durable Objects:

- **`Durability`** — effectively-once operations with retries, idempotency, and result lookup.
- **`DurabilityAlarms`** — named logical alarms with retries and stable idempotency keys.
- **`DurabilityFanout`** — durable batch acceptance and independent delivery to static consumer or storage targets.
- **`DurabilityRouting`** — a DO-side load observer and client-side shard selector (`durability/routing`), supporting location hints and caller transforms.

Durable capabilities own their storage and migrations. Routing observations are in-memory and advisory. When an object composes durable capabilities, one `DurabilityScheduler` shares its physical alarm and concurrency pool. No queue factory, generated DO class, or special consumer superclass is required.

Durability is not an event-sourcing, replay-log, or workflow-orchestration engine. Operation methods return `Promise<void>` after registration commits; they do not wait for the handler result. Failed work is retried from later alarms. Both SQLite-backed and KV-backed Durable Object classes are supported.

## Migrating to v3

The factory API is replaced by classes:

| v2                                                       | v3                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `createDurability(ctx, handlers, options)`               | `new Durability({ context: ctx, handlers, ...options })`           |
| `options.alarms` / `options.alarmMethods`                | `new DurabilityAlarms({ context: ctx, handlers, methods })`        |
| `durability.alarm.cleanup(time)`                         | `alarms.cleanup(time)`                                             |
| `migrateDurability(ctx, target)`                         | `Durability.migrate` / `DurabilityAlarms.migrate`                  |
| `durabilityMigrations`                                   | `durabilityOperationMigrations` / `durabilityNamedAlarmMigrations` |
| `purgeBefore(ts)` → `{ operations, namedAlarms, total }` | `purgeBefore(ts)` → `number` per helper                            |

Existing SQLite databases are upgraded transparently on first construction: no schema statement runs, the history table gains `capability` and `down` columns, and per-capability rows are recorded next to the combined v2 `durability_0004_generation_and_created_at` row. That row is kept so a rollback to 2.x also sees a complete history. Objects first created on 3.x with only one helper cannot be rolled back to 2.x, which expects both tables. `workers-qb` is no longer a dependency. The `alarmConcurrency` pool is now shared through a `DurabilityScheduler` when both helpers are used; standalone helpers each own a pool.

## Durable operations

```ts
import { DurableObject } from 'cloudflare:workers';
import { Durability, type DurableCall } from 'durability';

type ResizeInput = { imageId: string };

export class ImageJobs extends DurableObject<Env> {
  private readonly durability = new Durability({
    context: this.ctx,
    handlers: {
      resizeImage: async ({ id, payload }: DurableCall<ResizeInput>) =>
        this.env.IMAGES.resize(payload.imageId, { idempotencyKey: id }),
    },
    retries: { maxAttempts: 3 },
    methods: { resizeImage: { attemptTimeoutMs: 60_000 } },
  });

  resize(imageId: string) {
    return this.durability.resizeImage({
      id: `resize:${imageId}`,
      payload: { imageId },
    });
  }

  result(imageId: string) {
    return this.durability.resizeImage.getResult(`resize:${imageId}`);
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }
}
```

Every handler becomes a method on the instance. Handler names that collide with instance members (`alarm`, `purgeBefore`) are rejected at construction.

### Reading results

```ts
const result = await this.durability.resizeImage.getResult(`resize:${imageId}`);

switch (result.status) {
  case 'not_found':
    break;
  case 'pending':
    console.log(result.attempt, result.nextAttemptAt, result.lastError);
    break;
  case 'failed':
    console.error(result.error.name, result.error.message);
    break;
  case 'completed':
    console.log(result.result);
    break;
}
```

The completed result type is inferred from the handler. Looking up a key that belongs to another operation throws `DuplicateDurableCallError`. Payloads and results must be JSON-serializable.

## Named alarms

```ts
import { DurableObject } from 'cloudflare:workers';
import { DurabilityAlarms } from 'durability';

export class Subscription extends DurableObject<Env> {
  private readonly alarms = new DurabilityAlarms({
    context: this.ctx,
    handlers: {
      renew: async ({ idempotencyKey, signal }) => {
        await this.env.BILLING.fetch('https://billing.internal/renew', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          signal,
        });
      },
    },
    methods: { renew: { retryTimeouts: true, retries: { maxAttempts: 5 } } },
  });

  scheduleRenewal(at: number) {
    return this.alarms.renew(at);
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.alarms.alarm(info);
  }
}
```

Scheduling a name again replaces its pending occurrence. If that name is already running, the current handler continues and the replacement runs afterward. Different names may run concurrently, but one name never has more than one active handler in the same instance.

Named alarms inside the scheduler's `alarmMinDelayMs` window start from an in-memory timer at their requested time. The option accepts 1 to 15 seconds and defaults to 15 seconds; the scheduler never sets the physical alarm sooner than that delay; the physical alarm remains as a durable fallback for restarts. If concurrency capacity is full when the timer fires, execution waits in the shared FIFO queue. The scheduling method resolves after persistence and never waits for the handler to finish.

Each occurrence receives a new internal generation. Its `idempotencyKey` stays stable across retries while `attempt` increments. A successful handler removes only the occurrence it executed, so it cannot delete a replacement scheduled while it was running.

A timeout aborts the handler's `signal` and is terminal by default because the external outcome is unknown. Set `retryTimeouts: true` only when the handler's side effects use the idempotency key or reconcile their outcome before retrying. Named alarms remain at-least-once across eviction or restart.

## Using both in one Durable Object

A Durable Object has one physical alarm. When one object uses both helpers, create a `DurabilityScheduler` and pass it to each so they share the alarm, the storage backend, and the concurrency pool:

```ts
import { Durability, DurabilityAlarms, DurabilityScheduler } from 'durability';

export class ImageJobs extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({
    context: this.ctx,
    alarmConcurrency: 10,
    alarmMinDelayMs: 15_000,
  });

  private readonly durability = new Durability({
    scheduler: this.scheduler,
    handlers: {
      resizeImage: async ({ payload }) =>
        this.env.IMAGES.resize(payload.imageId),
    },
  });

  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: { cleanup: async () => this.env.IMAGES.cleanup() },
  });

  alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}
```

A helper configured with `context` instead of `scheduler` creates a private scheduler and accepts the scheduler options (`storageBackend`, `alarmConcurrency`, `alarmMinDelayMs`, `alarmHandoffMs`) in the same object. Two helpers on the same object must share one scheduler; otherwise each would reconcile the physical alarm against only its own records.

## Storage backends

SQLite is the default. Configure the Durable Object class with `new_sqlite_classes`; no option is required:

```jsonc
{
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ImageJobs"] }],
}
```

`Durability` creates and migrates `durability_calls`; `DurabilityAlarms` does the same for `durability_alarms`. Both histories are tracked in the shared `durability_migrations` table and only the constructed helpers' tables exist.

For a class backed only by the KV storage API, configure it with `new_classes` and select the backend:

```jsonc
{
  "migrations": [{ "tag": "v1", "new_classes": ["ImageJobs"] }],
}
```

```ts
const durability = new Durability({
  context: this.ctx,
  handlers,
  storageBackend: 'kv',
});
```

KV mode stores records and ordered pending/created indexes in the object's private key-value storage, never touches `storage.sql`, and creates no migration records. Records are not converted between backends; deploy a separate class or copy records explicitly before switching.

### Explicit migrations

Rollbacks are explicit because reverting the initial migration deletes records:

```ts
import { Durability, DurabilityAlarms } from 'durability';

Durability.migrate(this.ctx, 'durability_0001_create_calls');
Durability.migrate(this.ctx, null); // remove the operations schema entirely
DurabilityAlarms.migrate(this.ctx, null); // remove the named alarm schema
```

Passing a name moves that capability's schema to exactly that version. Each batch of migrations applies or reverts in one synchronous transaction, so a failure leaves the schema untouched.

Every history row stores its migration's `down` script. If a Durable Object later runs an older `durability` version, that version reverts the migrations it does not recognize using the stored scripts, so downgrades are safe without code changes. To guard against deploying a very old version by mistake, at most two unknown migrations are reverted; beyond that, construction throws. The `durability_migrations` table is dropped once no durability history remains.

## Retries, timeouts, and terminal failures

Attempts use exponential backoff with equal jitter, stop after five attempts, and time out after five minutes by default. The retry `delay` function fully controls scheduling and can be overridden globally or per method on either helper:

```ts
import { exponential, jitter } from 'durability/utils';

const durability = new Durability({
  context: this.ctx,
  handlers,
  attemptTimeoutMs: 60_000,
  retries: {
    maxAttempts: 5,
    delay: (attempt) => jitter(exponential(attempt)),
  },
  methods: {
    resizeImage: {
      attemptTimeoutMs: 10 * 60_000,
      retries: {
        maxAttempts: 2,
        delay: (attempt) => exponential(attempt, 500, 30_000),
      },
    },
  },
});
```

Each attempt receives its own `AbortSignal`. A timed-out operation follows the normal retry policy; a timed-out named alarm is terminal unless `retryTimeouts` is set. If a handler ignores abort, its in-memory lock and concurrency permit remain held until it actually settles, so a same-isolate retry cannot overlap it.

Throw `NonRetryableError` to move work directly to `failed` without another attempt. Errors named `NonRetryableError` from other packages, such as `cloudflare:workflows`, are recognized too.

## Delivery semantics and concurrency

Work is delivered at least once. A process can stop after a side effect succeeds but before its completion record commits, so handlers should be idempotent and pass the call ID or alarm `idempotencyKey` to external services.

`alarmConcurrency` defaults to 10 and is one FIFO limit shared by eager operation handlers, timer-driven work, and physical-alarm work attached to the same scheduler. Newly registered operations start eagerly only when a permit is immediately available. Work due before the physical-alarm minimum enters the same queue when its in-memory timer fires.

Completion records are retained indefinitely so IDs remain deduplicated. The scheduler owns the Durable Object's alarm; compose unrelated scheduled work as named alarms instead of replacing the physical alarm.

## Destructive retention purge

`purgeBefore(timestamp)` on either helper deletes that helper's records created strictly before `timestamp`, regardless of status, and returns the count. Records created exactly at the cutoff are retained.

```ts
const removedOperations = await this.durability.purgeBefore(retentionCutoff);
const removedAlarms = await this.alarms.purgeBefore(retentionCutoff);
```

SQLite purges in one transaction. KV purges in bounded transactions until no matching record remains, so retry if the invocation is interrupted. The purge best-effort aborts matching active handlers, but cannot force an abort-ignoring handler to stop. Operation IDs can be reused immediately; a late old generation cannot overwrite the replacement record.

## Lifecycle metrics hook

Each helper accepts `onLifecycleEvent`, which receives compact events for registration or scheduling, attempt start and settlement, pre-invocation attempt exhaustion, and purges:

```ts
const durability = new Durability({
  context: this.ctx,
  handlers,
  onLifecycleEvent: (event) => recordDurabilityMetric(event),
});
```

The hook is best-effort and non-blocking, is not a durable journal, and may duplicate or drop events across crashes. Hook failures are reported to `console.error` and never change queue state. Returned promises are attached to `waitUntil` when the context exposes it.

## Routing and fanout

A queue is a composition, not another exported abstraction. An application owns its DO class and attaches the capabilities it needs:

```ts
import { DurableObject } from 'cloudflare:workers';
import {
  DurabilityFanout,
  DurabilityScheduler,
  type FanoutInput,
  type StoredMessage,
} from 'durability';
import { DurabilityRouting } from 'durability/routing';

export class Mailbox extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly routing = new DurabilityRouting();
  private readonly fanout = new DurabilityFanout<Job>({
    scheduler: this.scheduler,
    routing: this.routing,
    targets: {
      consumer: { deliver: (messages) => this.env.CONSUMER.consume(messages) },
      archive: { storage: (message) => this.store('archive/', message) },
    },
    dlq: (message) => this.store('dead-letters/', message),
  });

  private async store(prefix: string, message: StoredMessage<Job>) {
    await this.env.ARCHIVE.put(
      `${prefix}${encodeURIComponent(message.id)}`,
      JSON.stringify(message),
      { onlyIf: { etagDoesNotMatch: '*' } }
    );
  }

  enqueue(messages: FanoutInput<Job>[]) {
    return this.fanout.enqueue(messages);
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

const routing = DurabilityRouting.client({
  target: Mailbox,
  invoke: (stub, messages: FanoutInput<Job>[]) => stub.enqueue(messages),
  sharding: (messages, context: { tenant?: string } | undefined) => ({
    shard: context?.tenant ?? messages[0]?.body.customerId ?? 'default',
    locationHint: 'weur',
  }),
});

const result = await routing.push([{ id: 'job:42', body: job }], {
  tenant: 'acme',
});
```

The application chooses the RPC method via `invoke`; routing does not know about messages or fanout. A single push selects one shard for the entire input. Static fanout target IDs identify independent delivery obligations; each accepted message snapshots its recipients. Targets added later do not receive old work, and a removed target's work remains durable with an error and backoff until that ID is restored. Target callbacks/storage references are fixed at capability construction.

### Acceptance, not completion

`fanout.enqueue` accepts a message or batch and returns:

```ts
type EnqueueResult<T> =
  | { success: true; value: T; load: LoadSnapshot }
  | {
      success: false;
      error: { name: string; message: string };
      load: LoadSnapshot;
    };
```

Fanout's value is the message ID array; an application RPC can return its own value with the same envelope. Success means the entire batch and its target obligations were committed, not that consumers ran. Definite validation/conflict rejection returns `success: false` with no partial batch. Storage/commit uncertainty throws, as does an RPC transport failure: the caller must not infer non-acceptance. Routing never silently retries or switches shards on a failed call. The caller decides whether to retry on the same or a different shard.

`id` defaults to a UUID. `deduplicationKey` defaults to `id`; while a registration remains active, repeating that key with identical ID, payload, and recipient set does not redeliver acknowledged siblings. Reusing it for different work rejects the batch. After the final target settles, the message manifest is removed and the key may be reused. This is not permanent or cross-shard deduplication. Consumers must make side effects idempotent for at-least-once delivery.

### Load and adaptive routing

A snapshot contains `observedAt`, `windowMs: 60000`, and:

- `inbound`: instantaneous `inFlight`, rolling `completed`, and `averageProcessingMs` for enqueue calls through acceptance/rejection.
- `outbound`: the same metrics for target delivery attempts (one batch to one target is one attempt), plus exact durable `pendingDeliveries` counting outstanding message-target pairs.

Counts and averages share a rolling window with one-second buckets. No samples means `null`, not zero; telemetry resets on eviction while backlog survives. A DO cannot measure requests waiting in the platform before its handler starts. Snapshots are advisory, not capacity reservations or global metrics.

`sharding(input, context, observations)` can inspect recent per-shard snapshots. Caller context can contain arbitrary local values; it is not persisted or sent to consumers. A location hint influences initial shard placement, not existing DO placement.

Without custom sharding, routing starts with one shard, samples two candidate shard keys, and compares backlog followed by in-flight processing pressure. It widens under backlog pressure (`softBacklogLimit`, default 1000) and narrows slowly when observations are shallow. Observations expire and are bounded per isolate; this is a best-effort adaptive router, not a globally coordinated autoscaler. Stable-key sharding gives affinity; random routing does not guarantee ordering between separate pushes.

### Independent delivery

First deliveries are ordered by enqueue sequence per shard and target. Waiting retries do not block later first deliveries; completion order is not guaranteed. Each scheduler pass advances a bounded batch per target (`maxBatchSize`, default 10) with the shared concurrency pool. Different targets progress independently subject to that capacity.

Consumer callbacks may forward the batch to any ordinary WorkerEntrypoint RPC method. Messages include `id`, `deliveryId`, `target`, `body`, `attempt`, `enqueuedAt`, and callable settlement capabilities:

- `ack()` settles this target only.
- `retry(10)` schedules eligibility after 10 ms, overriding the policy delay. It is not a real-time delivery guarantee.
- `deadLetter()` records durable terminal intent before writing to the DLQ. Exhaustion does the same automatically.
- Returning, throwing, or timing out leaves unsettled messages eligible for retry. A second or late settlement call rejects with `FanoutSettlementError`.

Await settlement calls. Timed-out RPCs cannot be forcibly cancelled, so side effects may overlap later attempts. Storage targets automatically acknowledge successful writes; failed writes retry independently of consumer targets. Their write contract must be idempotent by the supplied delivery identity.

### DLQ storage and per-target redrive

Fanout only ever **writes** to storage, so a storage target and the `dlq` are both just a write function:

```ts
type MessageWrite<Body> = (message: StoredMessage<Body>) => Promise<void>;
```

No adapter class or storage interface ships with the library: R2, DO storage, D1, or an HTTP endpoint are all one callback. What separates an archive from a dead letter is the **role in the flow**, not the type — a storage target receives every message on the success path, while `dlq` receives only what a target gave up on. Both may write to the same bucket under different prefixes.

A stored entry carries `id` (unique per registration and target), `messageId`, `target`, `body`, `enqueuedAt`, `storedAt`, and `attempts`; only dead letters also carry `failure: { reason, error }`.

Two write invariants are the application's to uphold:

- **Key each entry by `id` and refuse to overwrite it.** `id` is stable across delivery attempts, so a retried write collapses onto the same entry (`onlyIf: { etagDoesNotMatch: '*' }` on R2) and a redrive deletes exactly what it re-enqueued. `attempts` and `storedAt` advance between attempts, so entries are not byte-identical.
- **Delete only after acceptance.** Reading entries back for replay or redrive is application policy, so nothing in the library lists or removes them.

Retention is likewise external: filter on `storedAt` when selecting entries to redrive, and configure a **lifecycle deletion rule** on the prefix (for example 30 days on a DLQ prefix, unbounded for an archive) for physical expiry. A failed dead-letter write retains the terminal intent with a 60-second backoff rather than redelivering to the consumer, and omitting `dlq` retains terminal work rather than silently deleting it.

Redrive is explicit application code, not queue sugar. Walk your own storage, select what to replay, then enqueue only the failed target:

```ts
const result = await routing.push({
  messages: [
    { id: entry.messageId, body: entry.body, deduplicationKey: entry.id },
  ],
  options: { targets: [entry.target] },
});
if (result.success) {
  await dlq.remove(entry.id);
}
```

Here the application RPC forwards `messages` and `options` to `fanout.enqueue`. A fresh registration resets attempts; using the DLQ entry ID as the key avoids colliding with the original message's still-running siblings. Never remove an entry on rejection or transport uncertainty. A crash between re-enqueue and removal may still duplicate delivery.

### Transforms and build-time wiring

Routing uses the actual `@durability/transforms` runtime. For example, `routing.with(timeout, 5000).with(tenant, 'acme').push(input)` composes existing caller transforms. `tenant` is created with `defineTransform<RoutingSession<Input, Value, Context>, Context>().caller(...)`; context contributions shallow-merge, with transform fields overriding matching positional fields. An RPC timeout is not cancellation. Retrying a push may select a new shard, so choose stable keys when retry affinity matters.

`doTransforms` from `@durability/transforms/vite` maps `DurabilityRouting.client({ target: Mailbox, ... })` to its same-module exported class name and validates it against Wrangler. It injects `exportName`, not a generated DO or a magic application method. Without the plugin, set `exportName: 'Mailbox'` explicitly; `namespace: () => env.MAILBOXES` is an escape hatch for explicit or remote bindings.

Loopback namespaces need the application DO declared in Wrangler migrations (or the platform's supported class configuration), but no redundant DO binding block is needed. Consumer transport is explicitly wired by the application, such as a service binding or loopback entrypoint. See the typechecked [email queue composition](../../examples/email-queue).

## Retained log

Fanout deletes a record once every target settles it, which is what a work queue wants. A log wants the opposite: records are **retained** so a consumer can rewind, a new consumer can start from the beginning, and several consumers can read the same history at different speeds. `DurabilityLog` is that second shape, and it attaches to the same scheduler.

```ts
import { DurabilityLog, DurabilityScheduler, type LogRecord } from 'durability';

export class Partition extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly log = new DurabilityLog<Event>({
    scheduler: this.scheduler,
    retention: {
      maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxRecords: 100_000,
      maxBytes: 512 * 1024 * 1024,
    },
    // Flushed records stay readable: `write` returns a locator the log keeps,
    // and `read` hands the segment back when a consumer asks for it.
    cold: {
      write: async ({ records, firstOffset }) => {
        const locator = `segment/${this.ctx.id}/${firstOffset}`;
        await this.env.COLD.put(locator, JSON.stringify(records), {
          onlyIf: { etagDoesNotMatch: '*' },
        });
        return locator;
      },
      read: async (locator) => {
        const stored = await this.env.COLD.get(locator);
        return stored ? await stored.json<LogRecord<Event>[]>() : undefined;
      },
    },
  });

  append(events: Event[]) {
    return this.log.append(events.map((body) => ({ body })));
  }
}
```

`append` mirrors `enqueue`: the batch commits atomically, definite input rejections return `success: false`, and storage or commit uncertainty throws. It returns each record's **offset** in input order. Passing a `key` makes an append idempotent — re-appending an existing key returns its original offset and consumes no new one — so a producer that retries after an uncertain commit does not duplicate records.

Consumers **pull** and own their position:

```ts
const from = (await log.cursor('search')) ?? (await log.bounds()).oldestOffset;
const page = await log.read({ from, limit: 100 });
await index(page.records);
await log.commit('search', page.nextOffset);
```

`commit` only ever advances, so a late or duplicated commit cannot rewind a cursor. Cursors are independent: `log.cursors()` returns every consumer's position, and `log.load()` reports the furthest-behind cursor as backlog so routing can weigh partitions by consumer lag rather than by queue depth.

### Retention is not acknowledgement

Records leave only through `trim()`, which enforces `maxAgeMs` and `maxRecords`, oldest first. Retention is deliberately not automatic, because no capability should schedule work an application did not ask for. A `DurabilityAlarms` handler is the composition that gives it a schedule, and it keeps `alarm()` a pure delegation:

```ts
private readonly alarms = new DurabilityAlarms({
  scheduler: this.scheduler,
  handlers: { compact: () => this.log.trim() },
});

alarm(info?: AlarmInvocationInfo) {
  return this.scheduler.alarm(info);
}
```

`maxBytes` is the budget that actually matters, because a Durable Object holds a hot window rather than an unbounded log. It counts payload bytes held in the object and is capped at `maxLogBytes` (1 GiB), leaving room for the other capabilities sharing that object's storage.

### Flushing to cold storage, and reading it back

Retention has two possible destinations. Without `cold`, expiring records are **deleted**. With `cold`, they are **flushed** and stay readable:

```ts
type LogColdStorage<Body> = {
  write(segment: LogSegment<Body>): Promise<string>;
  read(locator: string): Promise<LogRecord<Body>[] | undefined>;
};
```

`write` receives one contiguous run of records, oldest first, and returns a locator — any string identifying where the segment went. The log stores that locator in a durable segment index **before** deleting the records, so a crash in between leaves a written, readable segment rather than records pointing nowhere. A failed write propagates with the records still in the object, so configured storage cannot be skipped, and writes are at-least-once, so key segments by first offset and refuse to overwrite.

`read` is what makes a flush **rehydratable**. A consumer reading a flushed offset gets its records back transparently, so falling behind the hot window is no longer fatal; `bounds()` reports `oldestOffset` (oldest readable, including flushed segments) alongside `hotOffset` (lowest offset still in the object). Cold reads cost a round trip and open input gates, so they serve only consumers that fell behind — never the hot path.

External storage expires on its own schedule, so mirror a lifecycle rule with `forgetColdBefore(offset)` to drop stale index entries. Returning `undefined` from `read` is also honoured: a segment the index outlived surfaces as truncation rather than a silent gap.

Retention still **ignores cursors**, exactly as a log should: a consumer slower than everything readable loses records. It learns loudly rather than silently skipping, because reading below the oldest readable offset throws `LogTruncatedError` carrying `requestedOffset` and `oldestOffset`. Compare `bounds()` against a cursor to detect the risk before it happens.

### Leases for parallel consumers

`read` plus `commit` is enough for one worker per consumer. It is **not** enough when two pollers share a consumer name: both read the same page and both process it. Leases close that gap.

```ts
const lease = await log.lease('search', 100);
if (lease) {
  try {
    await index(lease.records);
    await log.ack('search', lease.batchId);
  } catch {
    await log.nack('search', lease.batchId);
  }
}
```

`lease` claims a range of offsets durably **before** returning the records, so a second caller gets `undefined` rather than the same offsets. `undefined` means nothing is available right now — either the consumer is at `maxParallelism` or the log has no unleased records — so treat it as a signal to back off.

A range is held until it is acked, nacked, or its lease expires after `leaseMs`. Redelivery always issues a **fresh `batchId`**, which fences the previous holder: its `ack` throws `LogLeaseError` rather than committing a range someone else now owns. Double settlement throws for the same reason.

`maxParallelism` lets one consumer hold several ranges at once, and `ack` commits only over an **unbroken run** of settled ranges starting at the cursor. Acking a later range while an earlier one is still in flight advances nothing, so parallelism never skips offsets. Leases are durable, so eviction mid-flight does not release a range early, and a range that retention flushed while it was held is rehydrated on redelivery.

A range that keeps failing would be redelivered forever. `maxAttempts` bounds that, but only together with `onPoison`: without somewhere to send the records, blocking the consumer beats silently dropping them. With both set, an exhausted range is marked skipped — durably, before the callback runs, so a failing handler cannot resurrect it — and the commit then runs over it like an acked one.

Leases are opt-in. Without the `leases` option no lease tables are created, `read`/`commit` behave exactly as before, and the lease methods throw.

### What it is not

There is no per-record retry, timeout, or dead letter here: a log tracks positions, not attempts. When a single record must be retried independently of its neighbours, that is fanout's job, and the two compose on one object.

There is also no key compaction. `deduplicationKey` is unique per retained record, which is the opposite of a compaction key, and deduplication lasts only while the original record is retained — re-appending a key after its record was flushed or deleted creates a new record.

## Long-running alarm calls

Alarm invocations have a 15-minute wall-time limit. If work is still pending after `alarmHandoffMs` (default 14 minutes), the scheduler retains its promise in memory, arms a fallback after `alarmMinDelayMs`, and returns from the current invocation. The next alarm attaches to the same promise instead of starting the handler again. If the object is evicted during a handoff, the next alarm reconstructs and executes the persisted pending work.
