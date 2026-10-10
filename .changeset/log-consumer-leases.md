---
'durability': minor
---

Add opt-in consumption leases to `DurabilityLog`, so several workers can
consume one log in parallel without two of them receiving the same offsets.

`read` plus `commit` is enough for a single worker per consumer, but two
pollers sharing a consumer name both read the same page and both process it.
`lease` records a claimed range durably before returning its records, so a
concurrent caller gets nothing instead of the same offsets, and a range is held
until it is acked, nacked, or its lease expires.

Redelivery issues a fresh batch id, which fences the previous holder: a stale
or repeated settlement throws `LogLeaseError` rather than committing a range
another worker now owns. `maxParallelism` allows several ranges in flight per
consumer, and acking commits only over an unbroken run of settled ranges, so
parallel consumption never skips offsets that someone is still working on.
Leases are durable, so eviction mid-flight releases nothing early, and a range
flushed to cold storage while held is rehydrated on redelivery.

`maxAttempts` bounds endless redelivery of a failing range, but only alongside
`onPoison`: without somewhere to send the records, blocking the consumer beats
silently dropping them. An exhausted range is marked skipped durably before the
callback runs, and the commit then advances over it. Leases add a `logLeases`
migration capability on both the SQLite and KV backends, applied only when the
option is set.
