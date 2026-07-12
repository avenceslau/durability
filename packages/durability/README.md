# Durability

Alarm-backed, effectively-once operation execution for Cloudflare Durable Objects.

The package registers each operation and the first alarm in one Durable Object storage transaction. It only creates an alarm when none exists. Generated operation methods return `Promise<void>` after registration commits; they do not wait for the handler result. An alarm firing during execution attaches to the same in-memory promise. Failed calls are retried from later alarms, and a stable call ID deduplicates completed and concurrent calls. SQLite access and schema migrations are managed through `workers-qb`.

```ts
import { DurableObject } from 'cloudflare:workers';
import { createDurability, type DurableHandler } from '@repo/durability';

type ResizeInput = { imageId: string };

export class ImageJobs extends DurableObject<Env> {
  private readonly durability = createDurability(this.ctx, {
    resizeImage: (async ({ id, payload }) => {
      return this.env.IMAGES.resize(payload.imageId, { idempotencyKey: id });
    }) satisfies DurableHandler<ResizeInput, string>,
  });

  resize(imageId: string) {
    return this.durability.resizeImage({
      id: `resize:${imageId}`,
      payload: { imageId },
    });
  }

  alarm(alarmInfo?: AlarmInvocationInfo) {
    return this.durability.alarm(alarmInfo);
  }
}
```

## SQLite requirement

The Durable Object class must use SQLite storage:

```jsonc
{
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ImageJobs"] }],
}
```

`createDurability` migrates to the latest schema and stores calls in the `durability_calls` table. Each package migration has `up` and `down` SQL and is tracked in the namespaced `durability_migrations` table.

Rollbacks are explicit because rolling back the initial migration deletes durable call records:

```ts
import { migrateDurability } from '@repo/durability';

migrateDurability(this.ctx, 'durability_0001_create_calls');
migrateDurability(this.ctx, null); // roll back every durability migration
```

Passing a migration name moves the schema to that exact version, applying or reverting migrations as needed. Payloads and results must be JSON-serializable.

## Background batches and concurrency

The same typed handlers can be queued for timer-based background execution:

```ts
const durability = createDurability(this.ctx, handlers, {
  backgroundConcurrency: 20,
  alarmConcurrency: 10,
});

await durability.background.resizeImage({
  id: `resize:${imageId}`,
  payload: { imageId },
});
```

Each durability instance keeps at most one background timer active. A timer callback claims at most 100 due calls and runs them with `backgroundConcurrency`. Additional calls receive another timer callback. Immediate calls recovered by an alarm use `alarmConcurrency`; background calls recovered by an alarm continue through the timer pool.

Background results use the same operation-level API:

```ts
await durability.background.resizeImage.getResult(`resize:${imageId}`);
```

## Reading results

Results are read through the same typed operation using its idempotency key:

```ts
const result = await this.durability.resizeImage.getResult(`resize:${imageId}`);

switch (result.status) {
  case 'not_found':
    break;
  case 'pending':
    console.log(result.attempt, result.nextAttemptAt, result.lastError);
    break;
  case 'completed':
    console.log(result.result);
    break;
}
```

The completed result type is inferred from the operation handler. Looking up a key belonging to another operation throws `DuplicateDurableCallError` rather than returning a result with the wrong type.

## Delivery semantics

Calls are delivered at least once and deduplicated by ID after completion. Arbitrary external side effects cannot be made strictly exactly-once: a process can stop after the side effect succeeds but before its completion record commits. Pass the call ID to external services as an idempotency key to obtain effectively-once behavior.

Completion records are retained indefinitely so IDs remain deduplicated. The helper owns the Durable Object's alarm; compose unrelated scheduled work through the same alarm handler instead of independently replacing its alarm.

## Long-running alarm calls

Alarm invocations have a 15-minute wall-time limit. If a handler is still pending after 14 minutes, the helper retains its promise in memory, arms an immediate alarm, and returns from the current invocation. The next alarm attaches to the same promise instead of starting the handler again:

```ts
const durability = createDurability(this.ctx, handlers, {
  alarmHandoffMs: 14 * 60_000,
});
```

This handoff can keep a call running beyond one alarm invocation while the Durable Object remains in memory. It is intentionally backed by the persisted pending call: if Cloudflare evicts or restarts the object during a handoff, the next alarm reconstructs and executes the call again. External side effects still require the stable call ID as an idempotency key.
