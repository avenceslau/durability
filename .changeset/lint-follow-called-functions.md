---
'@durability/lint': minor
---

Follow calls into methods of the same class and functions declared in the same file. `no-alarm-changes-in-constructor`, `no-alarm-changes-in-alarm-handler`, `no-delete-all-in-transaction`, `no-deferred-storage-writes`, `transaction-sync-callback` and `alarm-runner-only` now report a call that leads to the problem, and `abort-after-sync` accepts awaiting a function that ends by syncing.
