---
title: API overview
description: Package entry points, core defaults, and links to the complete API reference.
---

## Entry points

| Import                              | Purpose                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `durability`                        | Operations, named alarms, scheduler, fanout, retained log, migration helpers, lifecycle types, and errors |
| `durability/utils`                  | Retry and timing utilities, including `exponential` and `jitter`                                          |
| `durability/routing`                | Object-side load observation and client-side shard selection                                              |
| `durability/socket`                 | Durable Object WebSocket server, typed events, and schema-validated inbound RPC                           |
| `durability/client`                 | Browser-safe WebSocket client and client transforms; no Workers runtime imports                           |
| `durability/experimental`           | Outbox, schedule, topology, and work tracking                                                             |
| `durability/experimental/semaphore` | Shared concurrency holder, client, and admission queue                                                    |
| `@durability/storage`               | Shared storage migration types                                                                            |
| `@durability/transforms`            | Typed caller/callee transforms for Cloudflare RPC                                                         |
| `@durability/transforms/vite`       | Build-time RPC and Durable Object wiring                                                                  |
| `@durability/lint`                  | Oxlint rules for migration and alarm delegation safety                                                    |
| `@durability/tanstack-db`           | TanStack DB collections over Durability socket snapshots and events                                       |

Import browser code from `durability/client`, and use type-only imports for Worker-side types in browser modules. Experimental APIs do not carry the stable root package's semver guarantee.

## Core configuration defaults

These defaults apply to operations and named alarms unless otherwise specified. Other capabilities define their own policies in the reference.

| Option                         | Default                      | Scope                                                                  |
| ------------------------------ | ---------------------------- | ---------------------------------------------------------------------- |
| `attemptTimeoutMs`             | `300_000` (5 minutes)        | Global execution policy or per method                                  |
| `retries.maxAttempts`          | `5`, including the first     | Global execution policy or per method                                  |
| `retries.delay`                | Jittered exponential backoff | Global execution policy or per method                                  |
| `methods.<name>`               | No overrides                 | Operation or alarm handler policy                                      |
| `methods.<name>.retryTimeouts` | `false`                      | Named alarms only                                                      |
| `alarmConcurrency`             | `10`                         | Shared scheduler; also accepted by a standalone helper using `context` |
| `alarmMinDelayMs`              | `15_000`                     | Physical alarm delay; allowed range `1_000`–`15_000`                   |
| `alarmHandoffMs`               | `840_000` (14 minutes)       | Shared scheduler alarm handoff                                         |
| `includeResults`               | `false`                      | Opt-in operation results in lifecycle events                           |

Pass **either** `context` (private scheduler) **or** `scheduler` (shared), not both. `handlers` defines the generated methods; names that collide with built-in instance members are rejected.

## Primitive reference

Each primitive has its own source file and navigation entry, with an API explanation and a **Behind the scenes** section:

- [Durability](/primitives/operations/), [DurabilityAlarms](/primitives/alarms/), and [DurabilityScheduler](/primitives/scheduler/).
- [DurabilityFanout](/primitives/fanout/), [DurabilityLog](/primitives/log/), and [DurabilityRouting](/primitives/routing/).
- [DurabilitySocket](/primitives/socket/) and [DurabilitySocketClient](/primitives/client/).
- Experimental: [Outbox](/primitives/outbox/), [Schedule](/primitives/schedule/), [Tracker](/primitives/tracker/), [Topology](/primitives/topology/), [Semaphore](/primitives/semaphore/), and [SemaphoreQueue](/primitives/semaphore-queue/).

Cross-cutting references cover [delivery guarantees](/reference/guarantees/), [retries](/reference/retries/), [memoization](/reference/memoization/), [migrations](/reference/migrations/), [retention](/reference/retention/), and [lifecycle hooks](/reference/lifecycle/).

For complete systems combining these APIs, read the [composition guides](/compositions/).

## Companion packages

These reference pages are generated from their respective package READMEs:

- [Storage](/reference/storage/) — shared migration types.
- [RPC transforms](/reference/transforms/) — caller/callee APIs, transform composition, built-ins, and Vite integration.
- [Lint rules](/reference/lint/) — plugin configuration and diagnostics.
- [TanStack DB](/reference/tanstack-db/) — collections, snapshots, mutation handlers, and connection sharing.

Edit primitive pages directly in `docs/src/content/docs/primitives/`. Edit a companion package's README to update its generated reference page; its edit link points to that source.
