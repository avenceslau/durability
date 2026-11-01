---
title: Choose a capability
description: Match operations, alarms, fanout, logs, sockets, and experimental tools to your workload.
---

Start with the smallest capability that matches your data's lifetime. Combine helpers on one shared `DurabilityScheduler` when they need durable background work.

## Stable capabilities

### Operations: retry a job and keep its result

Use `Durability` for an individually identified operation whose outcome you need to retrieve. Registration deduplicates the same ID and payload, and completed or failed records remain until purged.

[Operations reference](/primitives/operations/#durable-operations) · [Runnable quickstart](/getting-started/)

### Named alarms: replace a pending reminder

Use `DurabilityAlarms` for deferred work keyed by a handler name. Scheduling that name again replaces its pending occurrence. A running handler continues; the replacement runs afterward. A successful occurrence is removed rather than retained as permanent history.

A named alarm is not a cron parser. For simple recurrence, schedule the next occurrence from your handler. For independently tracked overlapping runs, consider experimental `DurabilitySchedule`.

[Named alarms reference](/primitives/alarms/#named-alarms) · [Subscription example](https://github.com/avenceslau/durability/tree/main/examples/subscription-renewals)

### Fanout: every message, independently delivered

Use `DurabilityFanout` when every accepted message must reach one or more static consumer or storage targets. Each message-target pair retries independently. Once every target settles, the registration is removed; this is not permanent deduplication or a retained event stream.

Consumer delivery must explicitly settle messages, or configure `ackOnReturn: true` for whole-batch acknowledgement. Storage targets acknowledge successful writes. DLQ storage, retention, and redrive are application-owned.

[Fanout reference](/primitives/fanout/#routing-and-fanout) · [Email queue example](https://github.com/avenceslau/durability/tree/main/examples/email-queue)

### Retained log: consumers own their positions

Use `DurabilityLog` when readers need a history they can rewind or consume at different speeds. Records leave through explicit retention trimming, not acknowledgement. Consumers read and commit cursors; optional leases coordinate parallel pollers sharing a consumer name.

Retention ignores consumer position. A reader that falls behind the readable history gets `LogTruncatedError`; provide a rebuild policy. Optional cold storage keeps flushed segments readable.

[Log reference](/primitives/log/#retained-log) · [Event topics example](https://github.com/avenceslau/durability/tree/main/examples/event-topics)

### Routing: select an object, not a global queue

Use `DurabilityRouting` from `durability/routing` to choose shards using application keys or advisory load observations. It composes with caller transforms and leaves the application in charge of RPC wiring.

Routing does not silently retry or switch shards after failure. Observations reset on eviction and are not reservations or global capacity guarantees. Choose stable shard affinity when retries must reach the same deduplication domain.

[Routing reference](/primitives/routing/#load-and-adaptive-routing)

### Sockets: browser RPC and replayable events

Use `DurabilitySocket` from `durability/socket` to expose selected inbound handlers and replayable outbound events over a hibernatable WebSocket. The dependency-free browser client comes from `durability/client`.

Authenticate and authorize in your fronting Worker. A reconnect can require a snapshot resync, and an in-flight RPC lost on disconnect is rejected rather than automatically replayed. Use stable durable operation IDs for retried mutations.

Add `@durability/tanstack-db` to synchronize TanStack DB collections with socket snapshots and events.

[Socket reference](/primitives/socket/#browser-sockets) · [TanStack DB reference](/reference/tanstack-db/)

## Experimental capabilities

These APIs can change in a minor release. Pin exact versions and evaluate their failure semantics before depending on them.

| Capability                                                                                          | Use when                                                | Important distinction                                                                              |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`DurabilityOutbox`](/primitives/outbox/#outbox-experimental)                                       | Publish the latest value of a key until acknowledged    | Superseded versions may never be delivered; sinks must reject older versions                       |
| [`DurabilitySchedule`](/primitives/schedule/#recurring-schedules)                                   | Run a recurring schedule with overlapping, tracked runs | You supply the next-occurrence calculator; runs are attempted once, while outcome delivery retries |
| [`DurabilityTracker`](/primitives/tracker/#tracking-work-experimental)                              | Inspect work across helpers or custom sources           | RPC handles can wait; socket clients need plain records instead                                    |
| [`DurabilityTopology`](/primitives/topology/#shard-topology-experimental)                           | Publish shard membership and push shared configuration  | One coordinator owns each group; readers use the published read store                              |
| [`DurabilitySemaphore`](/primitives/semaphore/#semaphore-experimental)                              | Share a concurrency limit across many client objects    | The holder allocates permits; clients must report claims and releases                              |
| [`DurabilitySemaphoreQueue`](/primitives/semaphore-queue/#queueing-work-in-a-client-durable-object) | Queue work until a semaphore admits it                  | Provide a durable completion check so missed release hooks do not leak permits                     |

Most experimental APIs are exported from `durability/experimental`. Semaphores and their queue use the separate `durability/experimental/semaphore` entry point.
