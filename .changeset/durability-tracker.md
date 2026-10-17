---
'durability': minor
---

Add the experimental `DurabilityTracker` under `durability/experimental`. It lists work from operations, named alarms, and custom `TrackedSource` implementations, either as handles with `get()` and non-polling `wait({ timeoutMs })` that work over Workers RPC and Cap'n Web, or as plain records for JSON transports such as `DurabilitySocket`. Nothing is added to the root entry point or to the public types of `Durability` and `DurabilityAlarms`.
