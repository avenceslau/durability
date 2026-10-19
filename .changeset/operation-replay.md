---
'durability': minor
---

Add `retryFailed` to durable operations for remediating terminal failures in place. A `failed` record was operationally inert: re-registering its ID is a no-op, so the only recovery was a new ID or a destructive purge. `durability.sendEmail.retryFailed(id, options?)` moves the record from `failed` back to `pending` under its original ID, operation, and payload, opening a fresh retry cycle with a new attempt budget while preserving the lifetime attempt count (`retry_cycle` and `total_attempts` columns) and the previous terminal error until the new cycle settles.

The status check, generation bump, and physical-alarm reconciliation commit in one transaction, so concurrent callers open exactly one new cycle and a replay survives eviction before its next attempt. The call returns a result discriminated on `status`: `replayed`, `not_found`, `not_failed`, or `requires_force`. Only a plain `attempts_exhausted` failure replays without options; `non_retryable`, `timeout`, `policy_error`, `serialization_error`, and `payload_decode_error` require `force: true`, because re-running them is more likely to repeat an external effect whose outcome is unknown. Replay cannot undo or detect an already-committed side effect.
