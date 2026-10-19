---
'durability': major
---

Durable operation timeouts are now terminal by default, matching named alarms. A timed-out attempt aborts the handler's `signal` with `DurableAttemptTimeoutError` and fails the operation instead of silently scheduling another attempt, because a timeout leaves the external outcome unknown and a retry can overlap work the previous attempt may still complete remotely.

Set `retryTimeouts: true` in a method's options (the same per-method option named alarms already accept) to opt back into retrying timed-out operations. Enable it only when the handler's side effects use the call ID or otherwise reconcile their outcome before retrying.

Operations that relied on the previous retry-on-timeout behavior must add `retryTimeouts: true` to the affected methods to keep retrying after a major upgrade.
