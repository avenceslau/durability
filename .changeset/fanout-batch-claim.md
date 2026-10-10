---
'durability': patch
---

Claim a whole fanout delivery batch in one storage transaction instead of one per message. A delivery pass previously cost O(batch) commits (each reconciling the alarm), which capped a shard's throughput well below what its enqueue path could take.
