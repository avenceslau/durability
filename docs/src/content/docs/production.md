---
title: Production guide
description: Configure retries, retention, migrations, observability, and safe deployment.
---

## Before shipping

- Use SQLite-backed Durable Objects and export every configured class.
- Construct helpers once and share one scheduler per object.
- Delegate `alarm()` directly to the helper or shared scheduler.
- Authenticate and authorize public Worker and socket entry points.
- Use stable operation IDs and idempotent or reconciling external receivers.
- Set deliberate timeout, retry, concurrency, and retention policies.
- Treat an RPC timeout or transport failure as an uncertain outcome, not proof of non-acceptance.
- Keep experimental dependency versions pinned exactly.

## Retry and timeout policy

Operations and named alarms default to **five total attempts**, including the first, with jittered exponential backoff and a **five-minute attempt timeout**. Configure global defaults or override individual methods:

```ts
import { Durability, NonRetryableError, type DurableCall } from 'durability';
import { exponential, jitter } from 'durability/utils';

const jobs = new Durability({
  context: this.ctx,
  handlers: {
    send: async ({ id, payload, signal }: DurableCall<{ url: string }>) => {
      // Supply a trusted/validated URL; do not expose an unrestricted fetch proxy.
      const response = await fetch(payload.url, {
        method: 'POST',
        headers: { 'Idempotency-Key': id },
        signal,
      });
      if (response.status === 400) {
        throw new NonRetryableError('Receiver rejected the request');
      }
      if (!response.ok) {
        throw new Error(`Receiver returned ${response.status}`);
      }
    },
  },
  attemptTimeoutMs: 60_000,
  retries: {
    maxAttempts: 5,
    delay: (attempt) => jitter(exponential(attempt)),
  },
  methods: { send: { retries: { maxAttempts: 3 } } },
});
```

This fragment belongs inside a Durable Object. Its receiver must actually honor the idempotency header or reconcile uncertain outcomes; sending a header alone supplies no guarantee. `fetch()` does not throw for non-success HTTP statuses, so handlers must check the response themselves.

A timeout aborts the handler's `signal`; it cannot forcibly stop code that ignores abort. The in-memory lock and concurrency permit remain held until that handler settles. After eviction, external work may still overlap a later attempt.

Timed-out **operations** follow the retry policy. Timed-out **named alarms** are terminal by default because their external outcome is unknown. Enable per-method `retryTimeouts: true` only for idempotent or reconciling effects.

Throw `NonRetryableError` for a known terminal failure. Do not classify a transport timeout as a definite business rejection.

[Full retry policy](/reference/retries/#retries-timeouts-and-terminal-failures)

## Retention is destructive

Operations retain completion and failure records indefinitely so IDs stay deduplicated. Budget storage and choose an explicit retention policy.

`purgeBefore(timestamp)` deletes records **created strictly before** the cutoff, including pending or active work. It is not a completed-only cleanup API. It also removes memoized results and allows operation IDs to be reused. Best-effort abort cannot undo an external effect.

Do not schedule a blanket purge unless deleting unfinished work is intentional. Keep any permanent business deduplication ledger in the authoritative receiver, independently of Durability's retention.

Other capabilities have different lifetimes:

- Successful named alarm occurrences are removed.
- Fanout manifests disappear after every target settles; archive and DLQ expiry belong to your storage policy.
- Logs trim only when you call `trim()`; retention ignores consumer cursors.
- Socket event replay is bounded by its retention window; clients must handle resync.

[Retention purge](/reference/retention/#destructive-retention-purge) · [Log retention](/primitives/log/#retention-is-not-acknowledgement)

## Schema migrations and rollbacks

There are two distinct migration layers:

1. **Wrangler migrations** create the Durable Object class as SQLite-backed, using `new_sqlite_classes` and new migration tags.
2. **SQL migrations** create and update the helper's tables inside each object when that helper is constructed.

Durability tracks capability migrations in `durability_migrations`. Application tables can use exported `migrate()` with their own history table. A migration batch applies or reverts in one synchronous transaction.

Explicitly moving a capability to `null` removes its schema and records. Treat this as destructive maintenance, not routine startup. Stored down scripts support downgrades, but construction rejects more than two unknown migrations rather than silently reverting an arbitrarily old deployment.

[Storage and migrations](/reference/migrations/#storage)

## Observability without an accidental audit log

`onLifecycleEvent` receives structural events for registration, attempts, settlement, and purge. Hooks are best effort and non-blocking; they can duplicate or drop across crashes. Never make a business guarantee depend on a telemetry hook firing.

Payloads and results are omitted by default, but event IDs are raw application keys and errors include messages. Hash or remove sensitive/high-cardinality fields before forwarding them. `includeResults: true` explicitly exposes completed results to hooks; enable it only for trusted consumers.

The scheduler's experimental `onAlarmRetry` hook reports a failed alarm pass after its fallback alarm is armed. Hook failure does not change scheduling.

Build-time `__DURABILITY_DEV__` tracing logs payloads, results, SQL, and bindings verbatim. Keep it disabled in production where these may contain secrets.

[Lifecycle hooks](/reference/lifecycle/#lifecycle-metrics-hook) · [Tracing](/reference/tracing/#dev-mode-tracing)

## Troubleshooting

| Symptom                                         | Check                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Jobs register but do not progress after restart | Exported class, SQLite migration, `alarm()` delegation, and shared scheduler wiring    |
| Submission resolves without a result            | Expected: registration is acceptance; call `getResult(id)`                             |
| A repeated submission throws                    | Confirm the ID is bound to the same operation and identical payload                    |
| External effects happen twice                   | Receiver-side deduplication and the crash window between effect and local settlement   |
| A named alarm stops after a timeout             | Timeout is terminal by default; only opt into retries when safe                        |
| Fanout consumers receive messages again         | Await settlement calls or configure whole-batch `ackOnReturn`; keep effects idempotent |
| A socket reconnect loses live state             | Handle `on.resync` and fetch a fresh snapshot                                          |
| A log consumer throws `LogTruncatedError`       | It fell behind readable retention; rebuild or resume according to application policy   |
| Routing seems unaware of backlog elsewhere      | Load observations are bounded, local, advisory, and reset on eviction                  |

The scheduler rearms a fallback after a failed alarm pass when possible. If even setting that fallback fails, the error reaches the platform's alarm retry mechanism. Monitor repeated alarm failures rather than assuming retry infrastructure can never fail.
