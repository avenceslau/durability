# Durability

A focused SQLite-backed operation queue for each Cloudflare Durable Object.

Each operation is persisted independently before eager execution. Generated operation methods resolve after registration commits; they do not wait for the handler result. Pending work and retries share the Durable Object's physical alarm with optional named alarms.

```ts
import { DurableObject } from 'cloudflare:workers';
import { createDurability, type DurableHandler } from 'durability';
import { z } from 'zod';

type ResizeInput = { imageId: string };

export class ImageJobs extends DurableObject<Env> {
  private readonly durability = createDurability(
    this.ctx,
    {
      resizeImage: (async ({ id, payload, signal }) =>
        this.env.IMAGES.resize(payload.imageId, {
          idempotencyKey: id,
          signal,
        })) satisfies DurableHandler<ResizeInput, string>,
    },
    {
      methods: {
        resizeImage: {
          payloadSchema: z.object({ imageId: z.string() }),
          resultSchema: z.string(),
        },
      },
    }
  );

  resize(imageId: string) {
    return this.durability.resizeImage({
      id: `resize:${imageId}`,
      payload: { imageId },
    });
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }
}
```

This package is an operation queue, not an event log or workflow engine. It does not provide replay, event sourcing, orchestration, durable sleeps, or rollback and saga infrastructure.

## Migrating to 3.x

This release has intentional breaking API changes. Every configured operation now requires a `methods` entry with Standard Schema `payloadSchema` and `resultSchema` validators. The schemas are typed against the handler's payload and awaited result, and Zod schemas implement Standard Schema directly. Alarm-only instances can still omit `methods`.

`DurableOperationResult` adds the `cancelled` member, persisted result metadata (`operationVersion` and `payloadVersion`) is required, and `purgeBefore` is now a reserved durability method name. Add concrete schemas for every handler, rename any operation called `purgeBefore`, and exhaustively handle `cancelled` results.

## Delivery and concurrency

Calls are delivered at least once across eviction and isolate failure. A crash can happen after an external side effect succeeds but before completion is persisted, so handlers should pass the stable call ID to external systems as an idempotency key.

`alarmConcurrency` is one FIFO in-process limit shared by eager operations, alarm-driven operations, and named alarms. A timed-out attempt aborts its signal, but arbitrary code cannot be forcibly stopped. Its per-ID lock and shared concurrency permit remain occupied until the actual handler settles. This prevents an abort-ignoring handler from overlapping a retry in the same isolate while preserving at-least-once recovery after actual isolate death.

Attempts are claimed with a persisted conditional increment. A pending row at `maxAttempts` becomes terminal without invoking attempt `maxAttempts + 1`.

```ts
const durability = createDurability(
  this.ctx,
  {
    resizeImage: (async ({ payload }) =>
      payload.imageId) satisfies DurableHandler<ResizeInput, string>,
  },
  {
    alarmConcurrency: 5,
    attemptTimeoutMs: 60_000,
    retries: {
      maxAttempts: 5,
      delay: (attempt) => Math.min(1_000 * 2 ** (attempt - 1), 30_000),
    },
    methods: {
      resizeImage: {
        payloadSchema: z.object({ imageId: z.string() }),
        resultSchema: z.string(),
      },
    },
  }
);
```

A retry delay callback must round to a non-negative safe integer, and adding it to the current timestamp must remain a safe integer. Invalid, overflowing, or throwing policies produce a terminal `DurableRetryPolicyError`.

The default attempt timeout is five minutes for both operations and named alarms. Queue-level `attemptTimeoutMs` changes that default; `methods.<operation>.attemptTimeoutMs` and `alarmMethods.<name>.attemptTimeoutMs` override it for one operation or alarm. Timeouts are terminal by default because an external outcome may be unknown. Enable `retryTimeouts` only for idempotent or reconciled effects. Attempt timeouts cannot be disabled; configure a larger positive integer when an attempt legitimately needs more time.

Payload schemas run before registration, and the validated or transformed value is what gets serialized and persisted. Recovered payloads are deserialized and validated again before handler invocation. Invalid registration rejects with `DurablePayloadValidationError` without persisting; invalid recovered data becomes terminal without invoking the handler.

Result schemas run before serialization and persistence, then completed results are deserialized and validated again when `getResult` returns them. Invalid results produce terminal `DurableResultValidationError`. Standard Schema validators may be synchronous or asynchronous. Values that validate but are not JSON-serializable, including unsupported values, circular structures, and `BigInt`, produce a terminal `DurableResultSerializationError` without rerunning the handler. Throw `NonRetryableError` for other permanent failures.

## Results and administration

`getResult` returns `not_found`, `pending`, `completed`, `failed`, or `cancelled`. Every persisted state exposes its `operationVersion` and `payloadVersion`.

```ts
const state = await this.durability.resizeImage.getResult('resize:image-1');
if (state.status === 'completed') {
  console.log(state.result, state.operationVersion, state.payloadVersion);
}
```

Operation methods expose administrative methods:

```ts
await this.durability.resizeImage.cancel(id);
await this.durability.resizeImage.retry(id);
await this.durability.resizeImage.delete(id);
```

- `cancel` changes pending work to `cancelled`, persists a `DurableCancellationError`, aborts a local signal when possible, and reconciles the physical alarm.
- `retry` accepts only failed or cancelled work, resets attempts and errors, preserves the ID and payload, and schedules immediately. It returns `unchanged` while an older local handler is still unsettled.
- `delete` physically removes the current generation and aborts local work best-effort.

Named alarm scheduler functions expose the same methods without an ID argument:

```ts
await this.durability.alarm.cleanup.cancel();
await this.durability.alarm.cleanup.retry();
await this.durability.alarm.cleanup.delete();
```

Mutation results discriminate `not_found`, `unchanged`, `updated`, and `deleted`.

`purgeBefore(timestamp)` destructively removes every operation and named-alarm record whose `created_at` is strictly less than the supplied non-negative safe-integer timestamp, regardless of status. This includes active, pending, and future-scheduled records; records created exactly at the cutoff are retained. Application and migration tables are never removed. The result contains operation, named-alarm, and total counts.

Delete and purge allow ID reuse. They cannot undo side effects that a handler already performed, including effects from active work being purged. Generation predicates prevent a late settlement from changing or deleting a replacement record.

## Version metadata

Persisted operation and payload versions default to `"1"`. Method options declare the current versions and explicitly accepted older versions. The persisted versions are passed to `DurableCall`.

```ts
const durability = createDurability(this.ctx, handlers, {
  methods: {
    resizeImage: {
      payloadSchema: z.object({ imageId: z.string() }),
      resultSchema: z.string(),
      operationVersion: '2',
      payloadVersion: '3',
      acceptedOperationVersions: ['1'],
      acceptedPayloadVersions: ['1', '2'],
    },
  },
});
```

Callers may set `operationVersion` and `payloadVersion` during registration; omitted values use the method's current versions. An incompatible pending record becomes terminal with `DurableVersionMismatchError` before handler invocation. Version strings must be non-empty and unique within each current-and-accepted list.

Named alarms use `handlerVersion` and `acceptedHandlerVersions` in `alarmMethods`. `DurableAlarmInfo` receives the persisted handler version. This is metadata-driven compatibility checking: the package does not retain historical callbacks or replay handlers.

## Named alarms

Named alarms share the same queue alarm and concurrency limit. Scheduling the same name replaces its current persisted occurrence with a new generation. A running old generation may finish, but generation predicates prevent it from modifying the replacement.

```ts
const durability = createDurability(
  this.ctx,
  {},
  {
    alarms: {
      cleanup: async ({ idempotencyKey, signal, handlerVersion }) => {
        await this.env.CLEANUP.fetch('https://cleanup.internal/run', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          signal,
        });
        console.log(handlerVersion);
      },
    },
    alarmMethods: {
      cleanup: {
        handlerVersion: '2',
        acceptedHandlerVersions: ['1'],
        retryTimeouts: true,
        retries: { maxAttempts: 3 },
      },
    },
  }
);

await durability.alarm.cleanup(Date.now() + 5_000);
```

A named-alarm timeout is terminal by default because its external outcome may be unknown. Enable `retryTimeouts` only for idempotent or reconciled effects. The generated idempotency key stays stable across retries of one generation.

Alarm invocations hand unfinished batches to an immediate new alarm after `alarmHandoffMs` (14 minutes by default). In-memory locks prevent overlap while the isolate survives; persisted pending rows recover work after eviction.

## Lifecycle metrics

`onLifecycleEvent` receives compact events for registration or scheduling, attempt start, completed/retry-scheduled/failed settlement, non-attempt terminal version mismatch or attempt exhaustion, cancel, retry, delete, and purge. Events include entity identity, generation, timestamp, attempt and versions where relevant. Settlement events include duration and error or next-attempt metadata when relevant.

```ts
const durability = createDurability(this.ctx, handlers, {
  methods: {
    resizeImage: {
      payloadSchema: z.object({ imageId: z.string() }),
      resultSchema: z.string(),
    },
  },
  onLifecycleEvent: (event) =>
    this.env.METRICS.writeDataPoint({
      indexes: [event.entityKind],
      blobs: [event.type, 'id' in event ? event.id : 'durability'],
      doubles: [event.timestamp],
    }),
});
```

Delivery is non-blocking and best-effort. When the supplied context exposes `waitUntil`, returned hook promises are attached to it; otherwise they are detached with a rejection sink. Hook failures emit one structured `durability.lifecycle_hook.failed` console event and never affect queue state or retry behavior. Unexpected detached eager, administrative retry, or alarm-handoff failures emit `durability.background_execution.failed`; background reporting also never changes queue state. Events may be duplicated or lost across crashes; use them as metrics signals, not as an audit log or durable lifecycle journal.

## SQLite and migrations

The Durable Object class must use SQLite storage:

```jsonc
{
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ImageJobs"] }],
}
```

`createDurability` migrates `durability_calls` and `durability_alarms` automatically. Reversible package migrations are tracked in the explicitly named `durability_migrations` table. Legacy records upgraded to v4 receive the migration timestamp for `created_at`, conservatively retaining them from cutoffs that predate the migration.

```ts
import { migrateDurability } from 'durability';

migrateDurability(this.ctx, 'durability_0003_create_alarms');
migrateDurability(this.ctx, null);
```

Passing `null` removes every durability-owned queue table and the `durability_migrations` history table. It does not remove application tables. Normal targeted rollback retains migration history so later migrations remain consistent. A targeted down migration from v4 is schema-reversible but semantically lossy: `cancelled` records become `failed`, and operation versions, payload versions, operation generations, handler versions, and created timestamps are discarded.
