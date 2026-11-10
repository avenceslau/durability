---
title: Lifecycle hooks
description: Lifecycle hooks for durable capabilities.
---

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

Events are built to be safe to forward to shared telemetry sinks: they carry structural fields (entity kind, operation or alarm name, idempotency `id`, `generation`, `attempt`, `durationMs`, `nextAttemptAt`) and a normalized `error` of `{ name, message }` with no stack, but **no payloads and no handler results by default**. The `id` is the raw idempotency key you chose, so hash or drop it before exporting to a metrics backend if it is high-cardinality or sensitive. Because an event is emitted per attempt, retry, and purge, treat these as counters and durations rather than an audit trail.

To include a `completed` settlement's handler `result` — for example to bridge results to a WebSocket or cache — opt in with `includeResults: true`. Enable it only when every attached hook is trusted with result content, since results may contain sensitive data:

```ts
const durability = new Durability({
  context: this.ctx,
  handlers,
  includeResults: true,
  onLifecycleEvent: (event) => recordDurabilityMetric(event),
});
```

Further hooks attach after construction with `lifecycle(hook)`, which returns a function that detaches it. `Durability` hooks are typed per operation: a `completed` settlement carries the handler's `result` only when `includeResults` is enabled, so the field is typed as optional.

```ts
const detach = durability.lifecycle((event) => {
  if (
    event.type === 'attempt_settled' &&
    event.outcome === 'completed' &&
    event.result !== undefined
  ) {
    publish(event.operation, event.result);
  }
});
```
