---
'durability': patch
---

Construct helpers with one read per capability when its schema is already current, instead of re-running the migration bookkeeping on every Durable Object wake. A construction of `Durability` and `DurabilityAlarms` on a migrated object now runs 3 statements instead of 21, so a wake that hits a transient storage error is far less likely to fail before it reaches pending work. A missing or older history table, a pending or newer migration, a changed `down` script, or any failure of the read still runs the full migration.
