---
'durability': minor
---

Add durable, best-effort cancellation for operations. Each operation method gains a `cancel(id, { reason? })` method that durably moves a `pending` call to a new terminal `cancelled` status, reconciles the physical alarm for the remaining work in the same transaction, and makes a best-effort attempt to abort a running handler by aborting its `signal` with a `DurableCancellationError`. A handler that ignores the signal may still settle, but its late completion or failure cannot overwrite the cancelled state because every attempt write is conditional on the row still being `pending`, so cancellation racing completion has a single transactionally enforced winner.

`cancel` is idempotent, safe when no live instance owns the work, and returns a discriminated outcome (`cancelled`, `already_cancelled`, `not_found`, `not_pending`, `wrong_operation`). The cancelled ID stays reserved, so re-registration remains deduplicated. `getResult` reports a new `cancelled` result with `attempt`, `cancelledAt`, `reason`, and `outcomeMayBeUnknown` — the guarantee is intentionally narrow and never claims that a side effect a running attempt may have committed was undone. A new migration (`durability_0012_calls_cancelled_status`) extends the `durability_calls` status constraint and adds `cancelled_at` and `cancel_reason` columns, with a down migration that maps cancelled rows back to `failed`.

Named-alarm cancellation is not included; schedule the name again to replace a pending occurrence, or use `purgeBefore` to remove records.
