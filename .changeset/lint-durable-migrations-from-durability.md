---
'@durability/lint': patch
---

`durability-migrations-only` now recognizes `DurableMigrations` imported from `durability`, the form the `durability` README documents. Migration lists typed through that import were reported as "CREATE TABLE statements must be declared in DurableMigrations."
