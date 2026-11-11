---
'durability': patch
---

Validate internal rows, messages, and options with Valibot instead of zod. The `zod` dependency is replaced by `valibot`. What is accepted and rejected is unchanged; only the wording of validation errors differs, for example `Invalid JSON value` when a payload is not JSON. Socket handlers still take any Standard Schema validator as `input`.
