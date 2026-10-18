# durability

## 4.2.0

### Minor Changes

- edaae65: Add experimental `DurabilityOutbox` (`durability/experimental`), keyed latest-state publication for application-owned Durable Objects. Stage the newest value for a key in the same transaction as the state it describes; the outbox coalesces superseded versions and republishes the newest one until `publish` acknowledges it. Several named channels share one scheduler and one set of tables.
- de341a2: `DurabilitySemaphore` can hand clients leases — blocks of permits drawn locally with no round trip — with three provisioning modes: `strict` (leases share the limit with grants, grants first), `under` (a reserve inside the limit is kept for leases), and `over` (a separate budget above the limit). `DurabilitySemaphoreQueue` draws from leases for queued items, treats drawn permits as one-shot, and reports `drawn`/`released` high-water marks through its outbox channel; `AdmittedItem.via` reports whether an item was admitted through a grant or a lease.
- 154b54d: Add experimental `DurabilitySemaphoreQueue` (`durability/experimental/semaphore`): the client half of `DurabilitySemaphore`. It queues items per semaphore key in arrival order, requests permits from the holder, admits items once their claims are confirmed, and publishes claims and releases through an internal `DurabilityOutbox` channel as cumulative counts. `DurabilityOutbox` gains a package-internal in-transaction staging path so helpers built on it commit their reports atomically with their own rows.
- 5df85e6: Add experimental `DurabilitySemaphore` (`durability/experimental/semaphore`): one concurrency limit held in an application-owned Durable Object and shared by many client Durable Objects. Requests are allocated in arrival-ordered rounds, groups may carry their own ceiling, and clients report claimed and released permits as cumulative counts so replays never free capacity twice. `DurabilitySemaphore.client()` mirrors `DurabilityRouting.client()`.

### Patch Changes

- Updated dependencies [5df85e6]
  - @durability/transforms@0.5.0

## 4.1.2

### Patch Changes

- 20fdbb1: Keep the physical alarm armed when an alarm run fails. The platform drops an alarm after a limited number of failed deliveries, and a storage error while a helper reconciled its alarm propagated as such a failure, so enough in a row left pending operations, named alarms and deliveries with nothing scheduled until some request happened to write. A failed run now arms the alarm at `alarmMinDelayMs` and reports `durability.alarm.failed`; only a failing `setAlarm` still reaches the platform.

## 4.1.1

### Patch Changes

- da530e2: Accept `undefined` properties and array elements in payloads, results, log bodies and socket events, treating them as `JSON.stringify` does (dropped and `null` respectively). Previously any value that merely contained an `undefined`, such as the lifecycle event of an operation or named alarm whose handler returned nothing, was rejected, so forwarding `lifecycle` to a `DurabilitySocket` or into another operation failed for those handlers.

## 4.1.0

### Minor Changes

- aeaa730: Reject reuse of a durable operation ID with a different payload. Registering the same ID for the same operation with the same data (compared canonically, so object key order does not matter) stays a no-op; a different payload now throws `DuplicateDurablePayloadError` instead of being dropped silently, matching how fanout treats a reused `deduplicationKey`.

## 4.0.0

### Major Changes

- 30cffc9: Drop support for KV-backed Durable Objects. Durability now requires a SQLite-backed class (`new_sqlite_classes`). The `storageBackend` scheduler option and the `DurabilityStorageBackend` type are removed. Records written by the KV backend are not migrated; drain or copy them before upgrading.

### Minor Changes

- 56a2019: Add the experimental `DurabilityTracker` under `durability/experimental`. It lists work from operations, named alarms, and custom `TrackedSource` implementations, either as handles with `get()` and non-polling `wait({ timeoutMs })` that work over Workers RPC and Cap'n Web, or as plain records for JSON transports such as `DurabilitySocket`. Nothing is added to the root entry point or to the public types of `Durability` and `DurabilityAlarms`.
- c9e3f59: Add `ackOnReturn` to fanout deliver targets, which acknowledges every message a consumer leaves unsettled in one transaction when `deliver` returns, and `batchDelayMs` to fanout, which holds first deliveries so messages enqueued together share one batch.
- 41d2dca: Drop terminal fanout deliveries when no `dlq` is configured instead of retaining them with a 60-second retry, which kept the Durable Object awake indefinitely. The `terminal` lifecycle event still reports each dropped delivery.
- 9b31346: Add opt-in consumption leases to `DurabilityLog`, so several workers can
  consume one log in parallel without two of them receiving the same offsets.

  `read` plus `commit` is enough for a single worker per consumer, but two
  pollers sharing a consumer name both read the same page and both process it.
  `lease` records a claimed range durably before returning its records, so a
  concurrent caller gets nothing instead of the same offsets, and a range is held
  until it is acked, nacked, or its lease expires.

  Redelivery issues a fresh batch id, which fences the previous holder: a stale
  or repeated settlement throws `LogLeaseError` rather than committing a range
  another worker now owns. `maxParallelism` allows several ranges in flight per
  consumer, and acking commits only over an unbroken run of settled ranges, so
  parallel consumption never skips offsets that someone is still working on.
  Leases are durable, so eviction mid-flight releases nothing early, and a range
  flushed to cold storage while held is rehydrated on redelivery.

  `maxAttempts` bounds endless redelivery of a failing range, but only alongside
  `onPoison`: without somewhere to send the records, blocking the consumer beats
  silently dropping them. An exhausted range is marked skipped durably before the
  callback runs, and the commit then advances over it. Leases add a `logLeases`
  migration capability, applied only when the option is set.

- 1e36a24: Add `DurabilityLog`, a composable capability for a retained, offset-addressed
  record log on an application-owned Durable Object.

  Where fanout deletes a record once every target settles it, a log retains
  records so consumers can rewind, start from the beginning, or read the same
  history independently at different speeds. `append` commits a batch atomically
  and returns each record's offset; supplying a key makes a repeated append
  return the original offset instead of duplicating the record. Consumers pull
  with `read` and own their position through monotonic per-consumer cursors that
  a late commit cannot rewind, and `load` reports the furthest-behind cursor so
  routing can weigh partitions by consumer lag.

  `trim` enforces `maxAgeMs`, `maxRecords`, and `maxBytes` retention, the last
  capped at `maxLogBytes` (1 GiB) because an object holds a hot window rather
  than an unbounded log. Retention has two destinations: without cold storage
  expiring records are deleted, and with it they are flushed and stay readable.
  A `cold.write` returns a locator recorded in a durable segment index before the
  records are deleted, so a crash leaves a readable segment rather than records
  pointing nowhere, and a failed write retains them in the object. `cold.read`
  makes a flush rehydratable, so a consumer reading a flushed offset is served
  from external storage transparently; `forgetColdBefore` mirrors an external
  lifecycle rule, and a segment the index outlived surfaces as truncation.

  Retention still ignores cursors, so a consumer slower than everything readable
  reads a `LogTruncatedError` naming the oldest readable offset rather than
  silently skipping records. Records persist through a new `log` migration
  capability.

- 83278bf: `conn.on.resync` now receives `{ names }`: the outbound events whose subscribers start without history. It fires for newly subscribed names on a live connection as well as for every name when replay fails, so a collection added later can seed itself without a connection-wide reload.
- 86bd0a9: Add `DurabilitySocket` (`durability/socket`) and `DurabilitySocketClient` (`durability/client`): typed WebSocket RPC and event push between browsers and a Durable Object over hibernatable WebSockets. Inbound handlers are validated with any Standard Schema validator, outbound events become typed methods on the socket, every event is persisted to SQLite with a sequence number so reconnecting clients replay what they missed or are told to resync, and `on.lifecycle` can stream `Durability` progress to browsers. Each helper now also exposes `lifecycle(hook)` to attach additional lifecycle hooks after construction, and operation `completed` events carry the handler's typed `result`.

### Patch Changes

- 9222234: Claim a whole fanout delivery batch in one storage transaction instead of one per message. A delivery pass previously cost O(batch) commits (each reconciling the alarm), which capped a shard's throughput well below what its enqueue path could take.
- fe89294: Keep the SQLite fanout pending-delivery count in memory (hydrated once per object lifetime, kept exact by inserts and removes, recounted after a failed transaction or purge) instead of counting the table on every enqueue, and fetch due deliveries with two indexed queries instead of one sorted scan. Both previously cost O(backlog) per call, so a shard that fell behind fell further behind.
- Updated dependencies [04943a3]
- Updated dependencies [24d0f4a]
  - @durability/transforms@0.4.0

## 3.0.1

### Patch Changes

- 2439c38: Run near-term work at its scheduled time with an in-memory timer, while keeping the physical alarm behind the configurable 1-to-15-second `alarmMinDelayMs` fallback.

## 3.0.0

### Major Changes

- 5536a95: Split durability into independent `Durability` and `DurabilityAlarms` classes that own their storage and migrations, sharing one physical alarm and concurrency pool through `DurabilityScheduler`. Add a KV-only storage backend behind a storage abstraction; SQLite remains the default. Replaces `createDurability`, `migrateDurability`, and `durabilityMigrations`; the combined v2 migration history is translated automatically, history rows now store their `down` scripts so downgrades revert unknown migrations (bounded to two), and migration batches apply atomically. `workers-qb` is no longer a dependency. The lint rule `alarm-runner-only` now recognizes the class constructors.

### Minor Changes

- c7d09c2: Add composable routing and fanout capabilities for application-owned Durable Objects, rather than a queue factory or generated shard/consumer classes. `DurabilityFanout` atomically accepts batches with frozen static target IDs and independently delivers to consumer or storage targets on SQLite and KV backends. Acceptance results include rolling in-memory ingress/egress completion counts, durations, in-flight work, and durable backlog. Per-target settlement supports ack, millisecond retry, durable dead-letter intent, and target-specific redrive. Storage destinations are plain write functions, so archives and dead letters share one `StoredMessage` envelope and ship no storage interface or adapter: applications write to R2, DO storage, or anything else in a callback, and own reading entries back, retention filtering, and lifecycle rules for redrive.

  `DurabilityRouting` supplies DO-side telemetry and a client with adaptive or user-supplied sharding, location hints, caller context, and the actual transforms `.with(transform, options)` API. Routing invokes one chosen application RPC per push and leaves retry/shard decisions to the caller. The Vite plugin injects routing target export names from application classes validated against Wrangler; lint recognizes fanout alarm delegation. Include typechecked examples composing the capabilities without queue sugar.

### Patch Changes

- Updated dependencies [c7d09c2]
  - @durability/transforms@0.3.0

## 2.1.0

### Minor Changes

- 0999d54: Extract the durability packages into a dedicated monorepo and add named alarm support.
- ff27153: Harden attempt limits, timeout overlap, retry/result failures, shared concurrency, generation-safe purging, and lifecycle metrics.

### Patch Changes

- Updated dependencies [0999d54]
  - @durability/storage@0.1.1
