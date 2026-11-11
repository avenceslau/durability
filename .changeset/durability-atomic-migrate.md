---
'durability': patch
---

Make `migrate()` and each helper's `migrate()` fully atomic. Reverting migrations recorded by a newer version used to commit on its own, so a later failure in the same call (for example a broken `up` script) left those migrations reverted; now the downgrade, the batch, and the history-table bookkeeping share one transaction, and a failed call leaves the schema and its history exactly as they were.
