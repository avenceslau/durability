---
'durability': minor
---

Add `DurabilityLog`, a composable capability for a retained, offset-addressed
record log on an application-owned Durable Object.

Where fanout deletes a record once every target settles it, a log retains
records so consumers can rewind, start from the beginning, or read the same
history independently at different speeds. `append` commits a batch atomically
and returns each record's offset; supplying a key makes a repeated append
return the original offset instead of duplicating the record. Consumers pull
with `read` and own their position through monotonic per-consumer cursors that
a late commit cannot rewind, and `load` reports the furthest-behind cursor so
routing can weigh partitions by consumer lag.

`trim` enforces `maxAgeMs` and `maxRecords` retention, handing expiring records
to an optional archive callback before deleting them and retaining them if that
archive fails. Retention ignores cursors, so a consumer slower than the window
reads a `LogTruncatedError` naming the oldest retained offset rather than
silently skipping records. Records persist through a new `log` migration
capability on both the SQLite and KV storage backends.
