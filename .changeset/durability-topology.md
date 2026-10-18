---
'durability': minor
---

Add the experimental `DurabilityTopology` to `durability/experimental`. A coordinator Durable Object holds the membership of shard groups, publishes each group's snapshot to a read store, and drives every member to the latest value of each state channel, both over `DurabilityOutbox` channels. Readers use `DurabilityTopology.client`, which caches snapshots, validates which coordinator published them, and never contacts the coordinator unless the application opts into a fallback.
