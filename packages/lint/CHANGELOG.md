# @durability/lint

## 0.3.0

### Minor Changes

- bfb08ea: Add the `transform-next-once` rule to report transform handlers that invoke their `next` function more than once.

### Patch Changes

- c6d97b6: Reject durability classes that omit alarm delegation or write physical alarms directly.

## 0.2.0

### Minor Changes

- 5536a95: Split durability into independent `Durability` and `DurabilityAlarms` classes that own their storage and migrations, sharing one physical alarm and concurrency pool through `DurabilityScheduler`. Add a KV-only storage backend behind a storage abstraction; SQLite remains the default. Replaces `createDurability`, `migrateDurability`, and `durabilityMigrations`; the combined v2 migration history is translated automatically, history rows now store their `down` scripts so downgrades revert unknown migrations (bounded to two), and migration batches apply atomically. `workers-qb` is no longer a dependency. The lint rule `alarm-runner-only` now recognizes the class constructors.

### Patch Changes

- c7d09c2: Add composable routing and fanout capabilities for application-owned Durable Objects, rather than a queue factory or generated shard/consumer classes. `DurabilityFanout` atomically accepts batches with frozen static target IDs and independently delivers to consumer or storage targets on SQLite and KV backends. Acceptance results include rolling in-memory ingress/egress completion counts, durations, in-flight work, and durable backlog. Per-target settlement supports ack, millisecond retry, durable dead-letter intent, and target-specific redrive. Storage destinations are plain write functions, so archives and dead letters share one `StoredMessage` envelope and ship no storage interface or adapter: applications write to R2, DO storage, or anything else in a callback, and own reading entries back, retention filtering, and lifecycle rules for redrive.

  `DurabilityRouting` supplies DO-side telemetry and a client with adaptive or user-supplied sharding, location hints, caller context, and the actual transforms `.with(transform, options)` API. Routing invokes one chosen application RPC per push and leaves retry/shard decisions to the caller. The Vite plugin injects routing target export names from application classes validated against Wrangler; lint recognizes fanout alarm delegation. Include typechecked examples composing the capabilities without queue sugar.

## 0.1.1

### Patch Changes

- 0999d54: Extract the durability packages into a dedicated monorepo and add named alarm support.
