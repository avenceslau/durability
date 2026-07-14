# Durability

Alarm-backed, effectively-once operation execution for Cloudflare Durable Objects.

The package registers operations and reconciles their earliest wake-up in one Durable Object storage transaction. Generated operation methods return `Promise<void>` after registration commits; they do not wait for the handler result. An alarm firing during execution attaches to the same in-memory promise. Failed calls are retried from later alarms, and a stable call ID deduplicates completed and concurrent calls. SQLite access and schema migrations are managed through `workers-qb`.

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

`createDurability` migrates to the latest schema and stores operations in `durability_calls` and named schedules in `durability_alarms`. Each package migration has `up` and `down` SQL and is tracked in the namespaced `durability_migrations` table.

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

A timed-out attempt aborts its signal and follows the normal retry policy. Abort-aware APIs stop promptly; arbitrary handler code cannot be forcibly terminated.

Throw `NonRetryableError` to move a call directly to `failed` without another attempt:

```ts
import { NonRetryableError } from 'durability';

throw new NonRetryableError('Recipient permanently rejected');
```

Errors created by `NonRetryableError` from `cloudflare:workflows` are also recognized.

## Delivery semantics

Calls are delivered at least once and deduplicated by ID after completion. Arbitrary external side effects cannot be made strictly exactly-once: a process can stop after the side effect succeeds but before its completion record commits. Pass the call ID to external services as an idempotency key to obtain effectively-once behavior.

Completion records are retained indefinitely so IDs remain deduplicated. The helper owns the Durable Object's alarm; compose unrelated scheduled work through the same alarm handler instead of independently replacing its alarm.

## Durable Object-to-Object coordination

When an operation spans multiple Durable Objects, a durability-enabled coordinator can retry each step after a crash, while durability-enabled participants deduplicate those retries using stable operation IDs. This supports sagas and other two-phase coordination scenarios with eventual consistency; it does not create one atomic storage transaction across the objects.

Intermediate states may be visible until every participant completes. Persist the coordination state, propagate stable IDs to every participant, and explicitly handle terminal failures or compensating operations when the operation can be aborted.

## Long-running alarm calls

Alarm invocations have a 15-minute wall-time limit. If a handler is still pending after 14 minutes, the helper retains its promise in memory, arms an immediate alarm, and returns from the current invocation. The next alarm attaches to the same promise instead of starting the handler again:

```ts
const durability = createDurability(this.ctx, handlers, {
  alarmHandoffMs: 14 * 60_000,
});
```

This handoff can keep a call running beyond one alarm invocation while the Durable Object remains in memory. It is intentionally backed by the persisted pending call: if Cloudflare evicts or restarts the object during a handoff, the next alarm reconstructs and executes the call again. External side effects still require the stable call ID as an idempotency key.
