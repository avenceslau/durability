---
'@durability/lint': patch
---

`alarm-runner-only` now follows imports from `durability`, so a helper constructed under an alias (`import { Durability as Jobs } from 'durability'; new Jobs(...)`) or through a namespace import (`new durability.Durability(...)`) is checked like `new Durability(...)`. Before, both forms let a class skip its `alarm()` delegation without a report.
