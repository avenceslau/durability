# Durability

A small, alarm-backed independent-operation queue for Cloudflare Durable Objects.

Durability is not an event-sourcing, replay-log, or workflow-orchestration engine. It registers independent operations and reconciles their earliest wake-up in one Durable Object storage transaction. Generated operation methods return `Promise<void>` after registration commits; they do not wait for the handler result. Failed calls are retried from later alarms, and a stable call ID deduplicates completed and concurrent calls. SQLite access and schema migrations are managed through `workers-qb`.

## Migrating to v3

`purgeBefore` is now reserved by the generated durability API, so rename any operation with that name before upgrading.

```ts
import { DurableObject } from 'cloudflare:workers';
import { createDurability, type DurableHandler } from 'durability';

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

## Named alarms

Named alarms share the Durable Object's physical alarm with durable operation retries. Configure handlers through `alarms`, then schedule them through the typed method on `durability.alarm`:

```ts
import ms from 'ms';
import { createDurability } from 'durability';
import { exponential, jitter } from 'durability/utils';

class ImageJobs extends DurableObject<Env> {
  private readonly durability = createDurability(
    this.ctx,
    {
      resizeImage: async ({ payload }) =>
        this.env.IMAGES.resize(payload.imageId),
    },
    {
      alarms: {
        cleanup: async ({
          scheduledTime,
          attempt,
          idempotencyKey,
          signal,
          platform,
        }) => {
          await this.env.CLEANUP.fetch('https://cleanup.internal/run', {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            signal,
          });
          console.log({ scheduledTime, attempt, platform });
        },
      },
      alarmMethods: {
        cleanup: {
          attemptTimeoutMs: 60_000,
          retries: {
            maxAttempts: 5,
            delay: (attempt) => jitter(exponential(attempt)),
          },
          retryTimeouts: true,
        },
      },
    }
  );

  scheduleCleanup() {
    return this.durability.alarm.cleanup(Date.now() + ms('5 seconds'));
  }

  alarm(alarmInfo?: AlarmInvocationInfo) {
    return this.durability.alarm(alarmInfo);
  }
}
```

Scheduling the same name again replaces its pending occurrence. If that name is already running, the current handler continues and the replacement runs afterward. Different names may run concurrently, but one name never has more than one active handler in the same Durable Object instance.

Each schedule receives a new internal occurrence ID. Its generated `idempotencyKey` remains stable across retries, while `attempt` starts at one and increments for every execution of that occurrence. A successful handler removes only the occurrence it executed, so it cannot delete a replacement scheduled while it was running.

Named alarms inherit the global attempt timeout and retry policy. `alarmMethods` overrides them for one name. Failures use the same jittered exponential delay as operations by default; `NonRetryableError` and exhausted attempts make the occurrence terminal. A timeout aborts the handler's `signal` and is terminal by default because the external outcome may be unknown. Set `retryTimeouts: true` only when the handler's side effects use the generated idempotency key or reconcile their outcome before retrying. If a handler ignores the signal, the scheduler retains its per-name execution lock until the handler actually settles, preventing an overlapping retry.

Named alarm handlers are still at-least-once across eviction or restart. Pass `idempotencyKey` to external systems that support deduplication.

## SQLite requirement

The Durable Object class must use SQLite storage:

```jsonc
{
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ImageJobs"] }],
}
```

`createDurability` migrates to the latest schema and stores operations in `durability_calls` and named schedules in `durability_alarms`. Each package migration has `up` and `down` SQL and is tracked in the namespaced `durability_migrations` table. The v4 migration adds generation and creation timestamps; existing records receive the migration time. Rolling back to `null` removes the durability tables and `durability_migrations`, without touching application tables.

Rollbacks are explicit because rolling back the initial migration deletes durable call records:

```ts
import { migrateDurability } from 'durability';

migrateDurability(this.ctx, 'durability_0001_create_calls');
migrateDurability(this.ctx, null); // roll back every durability migration
```

Passing a migration name moves the schema to that exact version, applying or reverting migrations as needed. Payloads and results must be JSON-serializable.

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
  case 'failed':
    console.error(result.error.name, result.error.message);
    break;
  case 'completed':
    console.log(result.result);
    break;
}
```

The completed result type is inferred from the operation handler. Looking up a key belonging to another operation throws `DuplicateDurableCallError` rather than returning a result with the wrong type.

## Retries, timeouts, and terminal failures

Attempts use exponential backoff with equal jitter, stop after five attempts, and time out after five minutes by default. The retry `delay` function fully controls scheduling and can be overridden globally or per operation. The package exports the default delay building blocks for custom policies:

```ts
import { exponential, jitter } from 'durability/utils';

const durability = createDurability(this.ctx, handlers, {
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

Each attempt receives its own `AbortSignal`:

```ts
const handlers = {
  sendEmail: async ({ payload, signal }: DurableCall<EmailPayload>) =>
    fetch(payload.url, { method: 'POST', signal }),
};
```

A timed-out operation aborts its signal and follows the normal retry policy. Named alarm timeouts remain terminal by default unless `retryTimeouts` is enabled. If a handler ignores abort, its in-memory ID lock and shared concurrency permit remain held until the real handler settles, so a same-isolate retry cannot overlap it. Across eviction or restart, delivery remains at least once.

Throw `NonRetryableError` to move a call directly to `failed` without another attempt:

```ts
import { NonRetryableError } from 'durability';

throw new NonRetryableError('Recipient permanently rejected');
```

Errors created by `NonRetryableError` from `cloudflare:workflows` are also recognized.

## Delivery semantics and concurrency

Calls are delivered at least once and deduplicated by ID after completion. Arbitrary external side effects cannot be made strictly exactly-once: a process can stop after the side effect succeeds but before its completion record commits. Handlers should be idempotent, and should pass the call ID to external services as an idempotency key when supported.

`alarmConcurrency` defaults to 10 and is one FIFO concurrency limit shared by eager operation handlers, alarm-driven operation handlers, and named-alarm handlers. Newly registered operations start eagerly only when a permit is immediately available; otherwise their persisted row is left for the reconciled alarm without creating an in-memory waiter. A timed-out handler that has not settled continues to occupy its permit.

Completion records are retained indefinitely so IDs remain deduplicated. The helper owns the Durable Object's alarm; compose unrelated scheduled work through the same alarm handler instead of independently replacing its alarm.

## Destructive retention purge

`purgeBefore(timestamp)` deletes every operation and named-alarm record whose creation time is strictly less than `timestamp`, regardless of status or scheduled time. Records created exactly at the cutoff are retained. The timestamp must be a non-negative safe integer.

```ts
const removed = await this.durability.purgeBefore(retentionCutoff);
console.log(removed.operations, removed.namedAlarms, removed.total);
```

The purge uses aggregate counts, deletes and reconciles the physical alarm in one storage transaction, and never touches application or migration tables. It best-effort aborts matching active handlers, but JavaScript cannot force an abort-ignoring handler to stop. Operation IDs can be reused immediately; a late old generation cannot overwrite the replacement record, but its already-started external side effects may still complete. A replacement named alarm remains serialized behind an abort-ignoring old handler with the same name until that handler settles or the isolate is evicted. Treat this API as intentionally destructive.

## Lifecycle metrics hook

`onLifecycleEvent` receives compact events for registration or scheduling, attempt start and settlement, pre-invocation attempt exhaustion, and purge aggregates. Events include timestamps, attempts, identities, and generation IDs needed to attribute metrics.

```ts
const durability = createDurability(this.ctx, handlers, {
  onLifecycleEvent: (event) => recordDurabilityMetric(event),
});
```

The hook is best-effort and non-blocking, is not a durable journal, and may duplicate or drop events across crashes. Hook failures are reported to `console.error` and never change queue state. Returned promises are attached to `waitUntil` when the context exposes it.

## Long-running alarm calls

Alarm invocations have a 15-minute wall-time limit. If a handler is still pending after 14 minutes, the helper retains its promise in memory, arms an immediate alarm, and returns from the current invocation. The next alarm attaches to the same promise instead of starting the handler again:

```ts
const durability = createDurability(this.ctx, handlers, {
  alarmHandoffMs: 14 * 60_000,
});
```

This handoff can keep a call running beyond one alarm invocation while the Durable Object remains in memory. It is intentionally backed by the persisted pending call: if Cloudflare evicts or restarts the object during a handoff, the next alarm reconstructs and executes the call again. External side effects still require the stable call ID as an idempotency key.
