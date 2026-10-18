---
'durability': minor
---

Add experimental `DurabilitySemaphoreQueue` (`durability/experimental/semaphore`): the client half of `DurabilitySemaphore`. It queues items per semaphore key in arrival order, requests permits from the holder, admits items once their claims are confirmed, and publishes claims and releases through an internal `DurabilityOutbox` channel as cumulative counts. `DurabilityOutbox` gains a package-internal in-transaction staging path so helpers built on it commit their reports atomically with their own rows.
