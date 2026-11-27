---
'durability': patch
---

`DurabilityLog` now stores records whose serialized body is larger than one SQLite row, splitting payloads over 1 MiB into parts that are reassembled on read, so a large record is still one record with one offset. `read` and `lease` accept `maxBytes` to bound a page or leased range by payload bytes. Cold segments are capped at 64 MiB of payload, so a read from the cold tier or a flush loads at most that, or one larger record.
