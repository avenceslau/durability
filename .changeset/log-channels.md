---
'durability': minor
---

`DurabilityLog` takes a `channel` option, so several logs share one object without sharing records. Each channel holds one instance per scheduler and has its own offset counter, deduplication keys, consumer cursors, retention and byte budget, cold segment index, leases, and allocations; a trim, lease, ack, or nack on one channel never affects another, even with the same consumer names, keys, or batch ids. `LogSegment` passed to `LogColdStorage.write` now carries the log's `channel`; cold storage shared between channels must include it in the keys it writes, since channels flush overlapping offsets. Migrations change the log tables to composite `(channel, …)` keys; existing records, cursors, segment locators, pending leases, and allocations stay on the default channel unchanged. Downgrading refuses to discard data of non-default channels.
