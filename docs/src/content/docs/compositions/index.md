---
title: Compose an application
description: End-to-end designs combining durable capabilities, application state, and external services.
---

A capability reference answers "what does this method do?" A composition answers **"where does this application's state live, what drives progress, and what happens when one part fails?"**

These walkthroughs follow complete Workers in the repository, rather than isolated API calls. Each explains the object boundaries, request path, durable handoffs, recovery behavior, and application-owned pieces needed to ship it.

## Pick a design

| Application                                                     | Capabilities composed                                     | Learn how to…                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Recurring billing](/compositions/recurring-billing/)           | Named alarms + operations + shared scheduler              | Separate the renewal clock from independently retried payment work                                |
| [Email delivery with an archive](/compositions/email-delivery/) | Routing + fanout + consumer RPC + R2 + transforms         | Accept a batch, progress independent targets, and redrive only failed deliveries                  |
| [Live job dashboard](/compositions/job-dashboard/)              | Operations + tracker + fanout + application SQL + sockets | Separate authoritative work from a browser-facing read model, using both push and RPC waits       |
| [Account-wide concurrency](/compositions/account-concurrency/)  | Semaphore + admission queue + operations + outbox         | Limit work across many job shards and recover permits when release notifications are lost         |
| [Replayable event stream](/compositions/event-stream/)          | Routing + retained log + named alarms + R2                | Partition writes, maintain independent consumer positions, and move old records into cold storage |

The concurrency and dashboard designs include experimental capabilities. The billing, email, and event-stream designs use stable entry points.

## The composition pattern

### 1. Choose ownership before choosing helpers

Name the authoritative object for each kind of state. An operation record belongs to the object that executes it; an account's concurrency budget belongs to its semaphore holder; a dashboard owns a projection, not the job's authoritative result.

Object names are part of this design. A stable name determines where state and deduplication live. Sending a retry to a different object is not the same as retrying inside the original object's deduplication boundary.

### 2. Share scheduling inside an object

Every helper that drives durable background work in one object must attach to its shared `DurabilityScheduler`. Delegate that object's `alarm()` to the scheduler. Another object gets its **own** scheduler; a scheduler is not a cross-object coordinator.

Routing's in-memory observer and the socket server do not need a separate physical alarm. Do not create independent alarm-owning helpers just because they serve different features.

### 3. Make each handoff explicit

At every boundary, distinguish:

- **Accepted:** the recipient has persisted the work.
- **Completed:** the business handler has settled successfully.
- **Observed:** a downstream projection or browser has seen the outcome.

Those are different moments. Awaiting operation registration does not wait for payment; acknowledging a fanout message does not prove a browser rendered it.

A shared scheduler does not create a distributed transaction. For each handoff, decide which durable state makes a retry safe and which ID the receiver deduplicates.

### 4. Pair every fast path with recovery

An eager operation, lifecycle hook, or socket notification is useful while the object is live. Ask what repairs the state if that signal never arrives:

- A persisted pending operation can restart through its physical alarm.
- A fanout delivery that committed can retry independently.
- A semaphore queue's `finished()` check recovers a lost release notification.
- A browser that loses event history rebuilds from a snapshot.

A best-effort hook is **not** made durable merely because the callback enqueues durable work: the process may stop before the enqueue commits. The dashboard guide calls out that gap and the reconciliation a production projection needs.

### 5. Decide what may be forgotten

Operation history preserves deduplication until purged. Fanout forgets settled registrations. Logs retain records until trimming. Outboxes keep only the latest staged state. Choose retention according to the application's needs, not a generic cleanup timer.

## Working with the examples

These are typechecked application recipes, not fully provisioned products. Open each guide's source and Wrangler links together. You still own authentication, external resources, receiver idempotency, business validation, and operational recovery.

For individual APIs, use the [reference](/reference/). For the source catalog and local validation commands, see [examples](/examples/).
