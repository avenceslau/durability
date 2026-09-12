---
'durability': major
'@durability/lint': minor
---

Split durability into independent `Durability` and `DurabilityAlarms` classes that own their storage and migrations, sharing one physical alarm and concurrency pool through `DurabilityScheduler`. Add a KV-only storage backend behind a storage abstraction; SQLite remains the default. Replaces `createDurability`, `migrateDurability`, and `durabilityMigrations`; the combined v2 migration history is translated automatically, history rows now store their `down` scripts so downgrades revert unknown migrations (bounded to two), and migration batches apply atomically. `workers-qb` is no longer a dependency. The lint rule `alarm-runner-only` now recognizes the class constructors.
