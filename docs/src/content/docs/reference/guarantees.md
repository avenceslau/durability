---
title: Delivery guarantees
description: Delivery guarantees for durable capabilities.
---

## Delivery and safety contract

Durability executes work **at least once** with a stable idempotency key per operation or named alarm occurrence. "Effectively once" is a business outcome you earn by making the receiver deduplicate that key or reconcile an uncertain prior outcome; it is never an unconditional platform guarantee. Read this before copying an example that mutates an external system.

| Concern                    | Guarantee                                                                    |
| -------------------------- | ---------------------------------------------------------------------------- |
| Registration / scheduling  | Exactly once — the durable record commits atomically or not at all.          |
| Local completion record    | Deduplicated by the stable key, so retries never double-record a result.     |
| Handler delivery           | At least once — a handler may run again after a crash, timeout, or eviction. |
| External side effect       | At least once — the library cannot close a cross-system transaction.         |
| "Effectively once" outcome | Your responsibility — requires an idempotent or reconciling receiver.        |

The unavoidable window: a handler asks an external system to commit an effect, the system commits it, then the acknowledgement is lost or the object stops before the local completion record commits. Durability retries the same stable key. Pass that key (`DurableCall.id`, or an alarm handler's `idempotencyKey`) to the external system so it can collapse the duplicate. An HTTP success — or failure — is not proof of the committed outcome after a lost acknowledgement.

For an operation, the stable key is the call `id` you choose. Namespace it per logical operation (`resize:${imageId}`), keep it stable across retries, and never reuse one key for different payloads: an ID stays bound to its operation and payload for the life of the record. For a named alarm, forward the occurrence's supplied `idempotencyKey`, **not its name**: rescheduling the same name creates a different occurrence.

A receiver must make deduplication authoritative at the effect's own boundary:

- If the effect is a mutation of the receiver's database, commit that mutation and its idempotency record in **one transaction**, returning the saved outcome for a repeated key.
- If the receiver calls another service, forward the key to that service's actual idempotency mechanism or reconcile its committed outcome before retrying.

A local `SELECT` followed by `await gateway.charge()` and then `INSERT completed` is **not** crash-safe deduplication. It can charge successfully and stop before inserting the marker, and concurrent requests can interleave during the await. Adding a pending row alone does not resolve an unknown remote outcome. This is the same uncertainty window illustrated in the [billing composition](/compositions/recurring-billing/).

When a receiver can neither deduplicate the key nor reconcile the prior outcome, do not retry the effect automatically: compensate (a saga) or require a human decision instead.
