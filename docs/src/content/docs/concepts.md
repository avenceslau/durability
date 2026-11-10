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

Cloudflare gives each Durable Object one physical alarm, and Durability gives each object one scheduler that owns it. With one helper, pass `context: this.ctx` and delegate `alarm()` to that helper. With several helpers, create a `DurabilityScheduler` and pass it to each:

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

A helper configured with `context` instead of `scheduler`, and any further `DurabilityScheduler` created for the same object, joins the object's scheduler. Whichever attaches can set scheduler options; an option left out never conflicts, and a different value for an option already set throws. The object's `alarm()` can delegate to the scheduler or to any helper's `alarm`: each runs the due work of every helper on the object.

Do not overwrite the object's physical alarm with `storage.setAlarm()` or omit alarm delegation. Express unrelated scheduled work as named alarms. Install `durability` once per Worker, as a peer dependency of libraries that use it: a second copy reaching the same object throws.

The scheduler's default concurrency budget is 10 handlers, shared across eager operations, timers, and alarm work attached to it. Physical alarms provide a durable fallback; in-memory timers can start work earlier but do not survive eviction. Timing is not a real-time guarantee.

## Channels keep instances apart

`Durability`, `DurabilityAlarms`, `DurabilityFanout`, `DurabilityLog`, `DurabilitySocket`, and the experimental `DurabilityOutbox`, `DurabilitySchedule`, `DurabilitySemaphore`, `DurabilitySemaphoreQueue`, and `DurabilityTopology` accept a `channel`, which defaults to `default`. Each channel of a helper kind holds one instance; attaching a second instance to a channel already in use throws.

Instances on different channels share the object's scheduler but not their records. IDs and names are unique within a channel, and each instance runs, lists, and purges only its own channel's work. A library that uses Durability inside your object should use a channel of its own:

```ts
// In a library
const alerts = new Durability({
  context: ctx,
  channel: 'durable-alerts',
  handlers: { notify },
});

// In the application, on the default channel
const jobs = new Durability({ context: this.ctx, handlers: { charge } });
// Both can register { id: 'invoice-1' }; they are different calls.
```

Records of a channel that no instance attached, such as one a deploy removed, are kept. Its due operations, alarms, fanout deliveries, and outbox entries are postponed by a minute, and a `durability.channel_missing` error is logged. Schedule and semaphore state stays unchanged until its instance attaches again, and log and socket history stays stored.

The channel is part of every persisted key. Records written before channels existed belong to `default` and keep their IDs and names. A schema downgrade refuses to discard records on other channels; remove that state deliberately before rolling back.

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
