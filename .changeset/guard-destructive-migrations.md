---
'durability': major
---

Guard destructive durability schema rollbacks and full resets. Reverting a migration drops the data it owns, so `Durability.migrate`, `DurabilityAlarms.migrate`, and the experimental helpers' `migrate` now require `{ allowDataLoss: true }` for any rollback and throw `DurableMigrationDataLossError` otherwise. `Durability.migrate` and `DurabilityAlarms.migrate` additionally refuse to roll back while pending work would be destroyed (pending operations, or pending/failed named alarms), throwing `DurableMigrationPendingWorkError` with the count unless `{ force: true }` is passed; the check runs inside the destructive transaction so nothing can slip between the safety check and the DDL. Both are now `async` and a full reset deletes the library-owned physical alarm so it cannot later fire against the dropped tables. The result now includes a `reset` flag. Forward migration is unchanged and remains acknowledgement-free, as is the automatic bounded downgrade that reverts unknown migrations.

This is a breaking change for callers that passed `null` (or any lower target) to remove a schema: they must now `await` the call and pass `{ allowDataLoss: true }`, and drain pending work or pass `{ force: true }`.
