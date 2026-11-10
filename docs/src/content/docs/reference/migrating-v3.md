---
title: Migrating from v2 to v3
description: Migrating from v2 to v3 for durable capabilities.
---

## Migrating to v3

The factory API is replaced by classes:

| v2                                                       | v3                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `createDurability(ctx, handlers, options)`               | `new Durability({ context: ctx, handlers, ...options })`           |
| `options.alarms` / `options.alarmMethods`                | `new DurabilityAlarms({ context: ctx, handlers, methods })`        |
| `durability.alarm.cleanup(time)`                         | `alarms.cleanup(time)`                                             |
| `migrateDurability(ctx, target)`                         | `Durability.migrate` / `DurabilityAlarms.migrate`                  |
| `durabilityMigrations`                                   | `durabilityOperationMigrations` / `durabilityNamedAlarmMigrations` |
| `purgeBefore(ts)` → `{ operations, namedAlarms, total }` | `purgeBefore(ts)` → `number` per helper                            |

Existing SQLite databases are upgraded transparently on first construction: no schema statement runs, the history table gains `capability` and `down` columns, and per-capability rows are recorded next to the combined v2 `durability_0004_generation_and_created_at` row. That row is kept so a rollback to 2.x also sees a complete history. Objects first created on 3.x with only one helper cannot be rolled back to 2.x, which expects both tables. `workers-qb` is no longer a dependency. The `alarmConcurrency` pool is now shared through a `DurabilityScheduler` when both helpers are used; standalone helpers each own a pool.
