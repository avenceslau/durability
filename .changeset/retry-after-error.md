---
'durability': minor
---

Add `RetryAfterError`, which a `Durability` operation handler or a named alarm handler can throw to ask for its next retry no sooner than `retryAfterMs` from the failure, for example to honour an HTTP `Retry-After`. The retry waits for the longer of the policy's `delay` and the hint, still counts against `maxAttempts`, and `NonRetryableError` and the last attempt remain terminal. The constructor throws `RangeError` for a negative or non-finite delay. Fanout and outbox already set explicit delays through `retry(delayMs)` and are unchanged.
