---
'durability': minor
---

Exclude payloads, results, and error messages from `DurabilityTracker` list output. `list` and `records` now return a summarized `state` — `pending` with `attempt`/`nextAttemptAt`, `failed` with `attempt` and `error.name`, and `completed` with only the status — so a page stays bounded and cannot leak secrets even when a completed result is large. The built-in `Durability` and `DurabilityAlarms` sources no longer deserialize results for list, and the tracker re-summarizes whatever a custom source returns. Full results remain available through a handle's `get()`/`wait()` and through `getResult(id)`.
