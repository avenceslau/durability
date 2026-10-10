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

`trim` enforces `maxAgeMs`, `maxRecords`, and `maxBytes` retention, the last
capped at `maxLogBytes` (1 GiB) because an object holds a hot window rather
than an unbounded log. Retention has two destinations: without cold storage
expiring records are deleted, and with it they are flushed and stay readable.
A `cold.write` returns a locator recorded in a durable segment index before the
records are deleted, so a crash leaves a readable segment rather than records
pointing nowhere, and a failed write retains them in the object. `cold.read`
makes a flush rehydratable, so a consumer reading a flushed offset is served
from external storage transparently; `forgetColdBefore` mirrors an external
lifecycle rule, and a segment the index outlived surfaces as truncation.

Retention still ignores cursors, so a consumer slower than everything readable
reads a `LogTruncatedError` naming the oldest readable offset rather than
silently skipping records. Records persist through a new `log` migration
capability on both the SQLite and KV storage backends.
