---
'durability': major
---

Drop support for KV-backed Durable Objects. Durability now requires a SQLite-backed class (`new_sqlite_classes`). The `storageBackend` scheduler option and the `DurabilityStorageBackend` type are removed. Records written by the KV backend are not migrated; drain or copy them before upgrading.
