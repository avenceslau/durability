---
'@durability/lint': minor
---

Add five rules for Durable Object storage and alarm behaviour: `abort-after-sync` requires `await ctx.storage.sync()` directly before `ctx.abort()`, `no-deferred-storage-writes` rejects storage writes that start after the request can respond, `transaction-sync-callback` rejects async `transactionSync()` callbacks, `no-delete-all-in-transaction` rejects `deleteAll()` inside transaction callbacks, and `no-alarm-changes-in-alarm-handler` rejects `setAlarm()` and `deleteAlarm()` inside `alarm()`.
