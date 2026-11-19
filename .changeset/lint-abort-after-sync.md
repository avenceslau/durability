---
'@durability/lint': minor
---

Add four rules for storage and alarm behaviour that the output gate does not protect: `abort-after-sync` requires `await ctx.storage.sync()` directly before `ctx.abort()`, `no-deferred-storage-writes` rejects storage writes that start after the request can respond, `transaction-sync-callback` rejects async `transactionSync()` callbacks, and `no-alarm-changes-in-alarm-handler` rejects `setAlarm()` and `deleteAlarm()` inside `alarm()`.
