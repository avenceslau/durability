# Durability Runtime Lab

This app is a destructive fault-injection harness for the `durability` package. It runs entirely locally in Workerd unless you explicitly deploy it.

## Run it

From the repository root:

```sh
pnpm lab
```

Open [http://localhost:8787](http://localhost:8787), choose a scenario, and inspect its persisted checks and event timeline. Local state is retained in `.wrangler/`; every run uses a unique Durable Object name, so runs do not contaminate each other.

Run the matrix headlessly with:

```sh
pnpm lab:test
```

## Architecture

Every run creates two SQLite-backed Durable Objects:

- `DurabilityLab` registers and executes operations through the workspace copy of `durability`. It also exposes internal call, logical-alarm, physical-alarm, and event evidence.
- `EffectLedger` acts like an external payment, email, or webhook receiver. It records every delivery separately from every committed effect and can deduplicate by the stable call ID.

This separation is important. A package can claim an operation completed once while an external receiver observed zero, one, or several effects. The lab judges both sides.

## Failure matrix

| Boundary                      | Injection                                        | Invariant                                          |
| ----------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| Baseline                      | Normal registration and execution                | One completed call and one effect                  |
| Before side effect            | Handler throws twice                             | Retry reaches attempt three; one effect            |
| Downstream RPC                | Receiver throws before commit                    | No phantom effect; retry recovers                  |
| After idempotent effect       | Receiver commits, then loses the acknowledgement | Multiple deliveries, one effect                    |
| After unprotected effect      | Receiver commits, then loses the acknowledgement | Duplicate effects are deliberately reproduced      |
| Before side effect            | `DurableObjectState.abort()` resets the object   | Registration and alarm recover in a fresh instance |
| After side effect             | Reset before completion persistence              | Stable receiver key prevents a duplicate           |
| After unprotected side effect | Reset before completion persistence              | Duplicate effect is deliberately reproduced        |
| Timeout                       | Handler honors `AbortSignal`                     | Timeout persists and a later attempt succeeds      |
| Timeout                       | Handler ignores `AbortSignal`                    | Late work overlaps a retry but is deduplicated     |
| Terminal policy               | `NonRetryableError`                              | One terminal attempt                               |
| Retry policy                  | Every attempt throws                             | Five attempts, then durable failure                |
| Registration                  | Twenty concurrent submissions of one ID          | One call record and one effect                     |
| Type boundary                 | One ID reused by another operation               | `DuplicateDurableCallError`                        |
| Logical alarm                 | First named-alarm attempt fails                  | Stable occurrence key across retry                 |
| Logical alarm                 | Same name scheduled twice                        | Only the replacement occurrence runs               |
| Concurrency                   | Twelve calls fail and become due together        | Bounded interleaving; every call completes once    |

The Worker-runtime tests additionally use Cloudflare's test controls to perform graceful eviction and immediate alarm delivery.

## What this can and cannot prove

The lab can prove behavior across real Workerd storage transactions, RPC boundaries, alarms, retries, handler timeouts, forced in-memory resets, and receiver deduplication.

It cannot deterministically manufacture every Cloudflare infrastructure failure. CPU-limit termination, memory exhaustion, regional network partition, platform overload, deploy-time reset, and a host process dying at an exact instruction require staging or production chaos runs. Those runs should reuse the same invariants and effect-ledger model rather than relying only on request status.

Do not treat the unprotected-effect warning scenarios as failures of the package. They demonstrate the unavoidable uncertainty window between an external side effect and persisting local completion. Production handlers must propagate the stable call ID to a receiver that deduplicates, or reconcile the receiver before retrying.

## Useful commands

```sh
pnpm --filter @durability/runtime-lab dev
pnpm --filter @durability/runtime-lab test
pnpm --filter @durability/runtime-lab typecheck
pnpm --filter @durability/runtime-lab build
pnpm --filter @durability/runtime-lab types
```

Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc`.

`wrangler.jsonc` uses Cloudflare's current declarative SQLite Durable Object exports. `wrangler.test.jsonc` describes the same two namespaces with legacy migrations because the currently installed Vitest pool bundles a Wrangler version from before declarative exports. Remove the test-only compatibility file once the pool consumes the modern configuration.
