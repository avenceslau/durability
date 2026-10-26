---
'durability': patch
---

Reduce redundant SQL calls and row writes without changing scheduling or retry behavior. Semaphore queues read their next pending time in one statement and skip unchanged key updates. Fanout and outbox claims persist their attempt number and existing retry deadline in a single update, retaining generation fencing and transaction rollback semantics.
