---
'durability': patch
---

Skip redundant physical alarm reconciliation in `registerChannel()` when an alarm is already active or the physical alarm is already aligned, and refresh only the in-memory early timer when a `DurabilitySchedule` hold loop exits instead of opening a duplicate storage transaction.
