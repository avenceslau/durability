---
'durability': minor
---

`DurabilitySchedule` gains an experimental `reschedule()` for a `nextOccurrence` whose answers change for a reason durability cannot see, such as which ticks the object owns. It asks `nextOccurrence` again from `now - jitterMs` and resolves `true` when the stored next tick changed, moving the alarm earlier or later in the same transaction, as a tick does. A stored tick that is already due is left to fire, ticks whose `dueAt` already passed are skipped rather than collapsed into a catch-up run, and no tick fires twice. The version, the stored jitter, cancels, runs, and outcome retries are unchanged, so `set()` and `cancel()` behave as before. `nextOccurrence` must still be synchronous, but no longer has to be deterministic.
