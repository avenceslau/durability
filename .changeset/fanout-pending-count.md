---
'durability': patch
---

Keep the SQLite fanout pending-delivery count in memory (hydrated once per object lifetime, kept exact by inserts and removes, recounted after a failed transaction or purge) instead of counting the table on every enqueue, and fetch due deliveries with two indexed queries instead of one sorted scan. Both previously cost O(backlog) per call, so a shard that fell behind fell further behind.
