---
'durability': minor
---

Persist and migrate operation payload versions across deployments. Every call now stores a `payload_version` (rows written before this feature, and operations without a configured version, are version 1, so plain handlers are unchanged). A method can declare the `payloadVersion` it writes and `migratePayload` upcasters keyed by the version they consume; a due call older than the configured version is upgraded by running each upcaster in order, committing the migrated payload and new version in one transaction before the handler is entered, so a crash afterward reuses the upgraded payload and never re-runs a migrator.

Work a deployment cannot run safely is left pending with an escalating backoff (one minute, growing with row age up to one hour) instead of being terminally failed, so retry budget is never spent and a later compatible deployment recovers it automatically. This covers a stored version newer than the deployment supports (a rollback), a missing or throwing migration step, and an operation whose handler is unregistered. The reason is recorded as a new `DurablePayloadCompatibilityError` on the pending row's `lastError` for inspection.

**Behavior change:** work for an unregistered handler previously failed terminally; it now stays pending indefinitely waiting for compatible code. If you remove a handler on purpose and want its pending rows discarded rather than retained, delete them explicitly with `purgeBefore`. This is a minor (not patch) bump because it adds API (`payloadVersion`/`migratePayload` options, `DurablePayloadCompatibilityError`, `PayloadMigrator`) and changes the terminal outcome of pending work for a removed handler.
