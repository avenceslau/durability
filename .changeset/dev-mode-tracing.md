---
'durability': minor
---

Add a build-time dev mode. Defining `__DURABILITY_DEV__` as `true` logs every public call, storage access, SQL statement, and lifecycle event as structured, sequence-numbered `console.debug` entries, so deterministic simulation tests can print or capture a full transcript. Production builds that define it as `false` drop the tracing code.
