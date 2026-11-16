---
'durability': patch
---

Fix five `DurabilityLog` bugs in cold flushing and leases:

- A retried cold flush now carries exactly the records of the first attempt. `trim()` records the range before calling `cold.write` and clears it in the transaction that indexes the segment and deletes the records, so an adapter that keys segments by first offset and refuses to overwrite, as the README advises, can no longer make the log index a shorter segment as covering more records and delete the records it never stored. This adds the `durability_0025_create_log_pending_flushes` migration.
- Overlapping `lease()` calls on one consumer, including calls that read flushed ranges from cold storage, no longer receive the same offsets or exceed `maxParallelism`.
- `ack()` and `nack()` throw `LogLeaseError` when the named consumer does not hold the batch, instead of settling another consumer's range.
- An `ack()` behind 100 or more settled ranges no longer exceeds the 100 bound parameters per query of SQLite-backed Durable Objects, which made it fail on every retry.
- Acking a range that retention trimmed entirely now deletes its lease row instead of keeping it forever.
