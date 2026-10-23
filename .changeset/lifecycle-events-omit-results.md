---
'durability': major
---

Lifecycle events no longer carry handler results by default. `onLifecycleEvent` and `lifecycle(hook)` emit structural metrics fields and a normalized `{ name, message }` error, but omit the `completed` settlement's `result` so events are safe to forward to shared telemetry sinks without leaking result content. Pass `includeResults: true` to `Durability` to restore the result on `completed` events for trusted hooks (for example, bridging results to a WebSocket).

This is breaking: the typed `result` on a `Durability` operation's `completed` event is now optional, and existing hooks that read `event.result` receive `undefined` unless they opt in. Persisted results and `getResult` are unchanged.
