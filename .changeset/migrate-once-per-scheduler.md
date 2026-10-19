---
'durability': patch
---

A scheduler checks each capability's schema once, however many helpers of that kind attach to it. Several outbox channels, a semaphore queue's internal outbox, or `DurabilityTopology` on outbox channels each re-ran the same migration check on every construction, adding statements (and chances to hit a storage error) to every wake of the object.
