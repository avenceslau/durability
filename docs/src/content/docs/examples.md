---
title: Examples
description: Runnable quickstart and typechecked application compositions.
---

## End-to-end composition guides

For architecture, durable handoffs, and diagrams of failure and recovery, start with:

- [Recurring billing](/compositions/recurring-billing/): a renewal clock and independently retried charges.
- [Email delivery and archive](/compositions/email-delivery/): routing, independent fanout targets, and dead-letter redrive.
- [Live job dashboard](/compositions/job-dashboard/): authoritative jobs, a durable projection, and browser synchronization.
- [Account-wide concurrency](/compositions/account-concurrency/): shared admission across job objects and recovery of lost releases.
- [Replayable event stream](/compositions/event-stream/): partitioned logs, independent consumers, and cold storage.

See [composition design](/compositions/) for how to choose object boundaries and recovery paths.

## Source examples

The repository's `examples/` workspace is typechecked with the libraries. The [getting-started example](/getting-started/) is self-contained. The other examples are integration recipes and may need application authentication, external service bindings, R2/KV resources, or build-time wiring before deployment.

| Example               | Demonstrates                                                                             | Source                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Getting started       | Self-contained word-count jobs, stable IDs, HTTP acceptance, and result lookup           | [Worker](https://github.com/avenceslau/durability/tree/main/examples/getting-started)                   |
| Image jobs            | Operation registration, upstream idempotency keys, result polling, and terminal failures | [Worker](https://github.com/avenceslau/durability/tree/main/examples/image-jobs)                        |
| Subscription renewals | Shared scheduler, named alarms, and operation chaining                                   | [Worker](https://github.com/avenceslau/durability/tree/main/examples/subscription-renewals)             |
| Email queue           | Routing, independent fanout, archive storage, DLQ, and redrive                           | [Worker and Vite config](https://github.com/avenceslau/durability/tree/main/examples/email-queue)       |
| Event topics          | Retained log, consumer positions, retention, and cold storage                            | [Worker](https://github.com/avenceslau/durability/tree/main/examples/event-topics)                      |
| Realtime todos        | Authenticated socket boundary, typed RPC, events, and TanStack DB                        | [Worker and browser client](https://github.com/avenceslau/durability/tree/main/examples/realtime-todos) |
| Job dashboard         | Tracking across objects, fanout push, and RPC handles that wait                          | [Worker](https://github.com/avenceslau/durability/tree/main/examples/job-dashboard)                     |
| Account concurrency   | Semaphore holder, admission queue, and permit lifecycle                                  | [Worker](https://github.com/avenceslau/durability/tree/main/examples/account-concurrency)               |
| RPC transforms        | Typed caller/callee wrapping and context propagation                                     | [Worker](https://github.com/avenceslau/durability/tree/main/examples/rpc-transforms)                    |

Read each example's configuration and the [repository example catalog](https://github.com/avenceslau/durability/blob/main/examples/README.md) for required bindings. Example snippets are not a promise that an external side effect is exactly once.

## Validate examples locally

From the repository root:

```sh
pnpm install
pnpm build
pnpm --filter durability-examples typecheck
```

The typecheck verifies API usage, not service credentials, production resources, or external business behavior. The library's unit and Worker integration tests run separately:

```sh
pnpm --filter durability test
```

Worker integration tests run locally through `@cloudflare/vitest-pool-workers` without Cloudflare credentials.
