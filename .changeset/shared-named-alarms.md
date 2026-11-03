---
'durability': minor
---

Let several `DurabilityAlarms` share one scheduler as long as their alarm names differ, so a library can create its own named alarms in an object that already has some. They share the `durability_alarms` table: one participant runs its due rows and hands each to the instance that owns its name, and `purgeBefore()` and tracked-source listings leave rows other instances own alone. Attaching a name another instance on the scheduler already owns throws. A due alarm no instance owns fails through the first instance attached, as before. No schema change.
