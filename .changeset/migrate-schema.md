---
'durability': minor
---

Add `migrate` for an application's own SQLite schema. It applies and reverts `{ name, up, down }` migrations the way durability migrates its tables, stores each `down` script so older code can revert up to two unknown migrations, and keeps the history in its own table (`schema_migrations` by default).
