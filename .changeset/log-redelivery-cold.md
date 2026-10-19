---
'durability': patch
---

`DurabilityLog` redelivers a whole leased range after retention flushed part of it to cold storage. A nacked or expired range spanning a cold segment boundary, or a segment and the hot window, was redelivered with only the records of its first segment, so a consumer acking it would skip the rest unseen.
