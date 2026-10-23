---
'durability': minor
---

Add `memoize(key, callback)` to durable operation and named alarm handlers. Once a key's callback succeeds, its result is persisted and every later call with that key, in a retry or in the same attempt, returns it instead of running the callback; a callback that throws persists nothing and runs again. A call for a key whose callback is still running rejects instead of waiting on it. Results live in a new `durability_memos` table shared by `Durability`, `DurabilityAlarms`, and `DurabilityFanout`, and are deleted in the transaction that settles the operation or alarm occurrence, when a named alarm is rescheduled, by `purgeBefore`, and when a helper's schema is reverted. A result that is not JSON-serializable fails the work with the new `DurableMemoSerializationError`.

Fanout messages get the same `memoize`, scoped to one message and target and deleted when the delivery is acked or dead-lettered. One record may memoize at most `maxMemosPerRecord` (1,000) keys of at most `maxMemoBytes` (1 MiB) each; exceeding either fails the work with the new `DurableMemoLimitError`. `DurabilityTracker` records of pending operations and alarms list their memoized keys as `state.memoized`.
