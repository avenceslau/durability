---
title: Identity and attempt numbers
description: Identity and attempt numbers for durable capabilities.
---

## Identity and attempt numbers

A handler receives several identifiers; only some are stable:

- **Operation `id`** (operations) and **`idempotencyKey`** (named alarms) are the logical identity. They are stable across every attempt and retry, so they are the only safe deduplication keys for downstream services.
- **`operation` / `name`** is the handler the work was registered under.
- **`attempt`** is the one-based ordinal of the current attempt, claimed in a durable write before the handler runs. It is retry/logging context, not an execution identity.
- **Named-alarm generation** is an internal token minted per scheduled occurrence; it backs `idempotencyKey` and is not exposed directly.

`attempt` is operational context for retry policies and logging, not a record of what the handler did. It is not strictly unique per handler entry: an entry whose claim write never commits can see the same number again on recovery. Cloudflare's output gates hold that entry's outbound fetches and RPCs until its storage writes are confirmed and discard them if the write is lost, so a replayed ordinal never corresponds to an escaped external effect — but it is still not a reliable "what already happened" signal.

That is why `attempt === 1` is not a durable "first run" gate. Attempt 1 can fail or time out before or after its effect, and retries carry a higher ordinal, so gating on the number either skips the effect forever once it increments or cannot tell whether the effect already ran. Gate once-only work on durable state keyed by the stable `id` instead, preferably in the authoritative receiver:

```ts
// Wrong: attempt is not a record of whether the effect ran. If attempt 1
// fails after charging, the retry (attempt 2) skips the charge; if it fails
// before, nothing distinguishes that from success.
if (attempt === 1) {
  await chargeCard(payload);
}

// Right: the receiver dedupes on the stable id, independent of attempt.
await this.env.BILLING.chargeOnce(id, payload);
```
