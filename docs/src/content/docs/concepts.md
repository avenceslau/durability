---
title: Concepts & guarantees
description: Understand durable registration, at-least-once execution, retries, and composition.
---

## You own the object

Durability provides helpers, not a generated Durable Object class. Your application owns the class, bindings, RPC endpoints, authentication, and application tables. Construct each helper once per object instance; its durable state lives in the object's SQLite database, not its JavaScript fields.

## Acceptance and completion are different

An operation method resolves after its registration commits. It returns `Promise<void>`, not the handler's result. Call `operation.getResult(id)` to observe `not_found`, `pending`, `completed`, or `failed`.

Fanout and log appends also distinguish durable acceptance from downstream progress. Never interpret successful enqueueing as proof that a consumer has finished.

## At-least-once execution

Registration commits atomically. Handler execution may repeat after failure, timeout, restart, or an uncertain external outcome.

The dangerous window is between **an external system committing an effect** and **the local completion record committing**. A lost acknowledgement can leave the caller unable to distinguish success from failure. Retrying is necessary for progress, but can repeat that effect.

Forward the handler's stable operation `id` or named-alarm `idempotencyKey` to a receiver that deduplicates or reconciles it. That receiver must preserve the key and effect atomically, or use the downstream system's own idempotency mechanism. Merely writing a local "done" row after an external request does not close the gap.

Do not use `attempt === 1` as a once-only guard: an attempt number says nothing about whether an effect committed. If a receiver cannot deduplicate or reconcile an effect, use compensation or human review instead of assuming retries are safe.

## Identity is part of your data model

Choose an ID for **one logical operation**, such as `invoice:123:send:v1`, and reuse it when retrying submission.

- The same operation, ID, and payload register once. Object property order does not matter; array order does.
- Another operation with the same ID throws `DuplicateDurableCallError`.
- A changed payload throws `DuplicateDurablePayloadError`.
- Completed and failed operation records remain until explicitly purged, preserving deduplication.
- Purging removes that protection. The same ID can then register new work.

Payloads and results must be JSON-serializable. JavaScript objects such as class instances are not preserved as instances across serialization.

## One object, one physical alarm

Cloudflare gives each Durable Object one physical alarm. With one helper, pass `context: this.ctx` and delegate `alarm()` to that helper. With several helpers, share a scheduler:

```ts
import {
  Durability,
  DurabilityAlarms,
  DurabilityScheduler,
} from 'durability';

// Fields on your Durable Object:
private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
private readonly jobs = new Durability({
  scheduler: this.scheduler,
  handlers: { refresh: async () => this.refreshIndex() },
});
private readonly reminders = new DurabilityAlarms({
  scheduler: this.scheduler,
  handlers: { cleanup: async () => this.cleanup() },
});

alarm(info?: AlarmInvocationInfo) {
  return this.scheduler.alarm(info);
}
```

The methods `refreshIndex()` and `cleanup()` above are application code. Give your own implementations idempotent effects.

Do not create independent private schedulers on the same object, overwrite its physical alarm with `storage.setAlarm()`, or omit alarm delegation. Express unrelated scheduled work as named alarms attached to the same scheduler.

The scheduler's default concurrency budget is 10 handlers, shared across eager operations, timers, and alarm work attached to it. Physical alarms provide a durable fallback; in-memory timers can start work earlier but do not survive eviction. Timing is not a real-time guarantee.

## Retrying a handler starts it again

Durability does not replay a workflow's execution history. Each retry invokes the whole handler. `memoize(key, callback)` can persist successful intermediate results while that work remains unsettled:

```ts
const targets = await memoize('targets', () => findTargets(payload));
for (const target of targets) {
  await memoize(`send:${target.id}`, () => sendIdempotently(target, id));
}
```

The functions in this fragment are application code. A callback that throws stores no result; a successful callback reuses its persisted JSON value on later calls. Memoized results are deleted on settlement, rescheduling, or purge. A crash between a callback's external effect and its memo commit can still repeat the effect.

Memoization is a retry optimization, not permanent storage or an exactly-once boundary. Read the [memoization limits and ownership rules](/reference/memoization/#memoize).

## Stable and experimental surfaces

Stable capabilities have dedicated root or subpath exports. APIs under `durability/experimental` and `durability/experimental/semaphore` may change in a minor release; pin an exact package version when using them. Some scheduler options and alarm cancellation are also explicitly marked experimental in the reference.
