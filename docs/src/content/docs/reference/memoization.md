---
title: Memoization
description: Memoization for durable capabilities.
---

## Memoize

A retried attempt runs the whole handler again. Wrap work that must not repeat in `memoize(key, callback)`, which operation handlers, named alarm handlers, and [fanout messages](/primitives/fanout/#independent-delivery) all receive. Once a key's callback succeeds, its result is persisted and every later call with that key returns it instead of running the callback:

```ts
const deliver = async ({ payload, memoize }: DurableCall<Batch>) => {
  const targets = await memoize('targets', () => lookUpTargets(payload));
  const results = await Promise.allSettled(
    targets.map((target) =>
      memoize(`send:${target.id}`, () => send(target, payload.events))
    )
  );
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) {
    throw new AggregateError(failed.map((result) => result.reason));
  }
};
```

Here a retry sends only to the targets that failed, and does not look them up again.

- **Keys.** A key is a non-empty string that identifies one piece of work within the operation or alarm occurrence. Calling a key again returns its result, whether the call comes from a later attempt, later in the same attempt, or from inside another key's callback. A call for a key whose callback is still running rejects instead of waiting, including one made from that callback, which would otherwise wait on itself; await the first call instead.
- **Results.** A callback that throws persists nothing; the next call with that key runs it again. Results must be JSON-serializable, and `memoize` returns the persisted form even on the first run, so a replay sees the same value. A result that cannot be serialized fails the work with `DurableMemoSerializationError` and no retry.
- **Ownership.** Only the attempt that owns the record can run or persist a callback. Once its alarm is rescheduled or its record purged, a `memoize` call rejects without running, and one already running rejects instead of writing.
- **Limits.** One operation, alarm occurrence, or fanout delivery may memoize at most `maxMemosPerRecord` (1,000) keys, and each serialized result may be at most `maxMemoBytes` (1 MiB) of UTF-8. A call that would exceed either fails the work with `DurableMemoLimitError` and no retry; a key that would exceed the count is rejected before its callback runs.
- **Cleanup.** Memoized results are deleted in the transaction that settles the operation (completed or failed), the alarm occurrence, or the fanout delivery (acked or dead-lettered), when a named alarm is rescheduled, and by `purgeBefore`. Nothing is kept once the work is done.
- **Tracking.** Pending operations and alarms list their memoized keys as `state.memoized` in [`DurabilityTracker`](/primitives/tracker/#tracking-work-experimental) records, in the order they were saved. Results themselves are not exposed.

Memoizing does not change delivery semantics. A process can stop after a callback's side effect succeeds but before its result commits, so the callback can run again; keep its side effects idempotent.
