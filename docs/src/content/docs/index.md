---
title: Durable work. Your objects.
description: Composable durable operations, alarms, delivery, and realtime sync for Cloudflare Workers.
---

Add durable capabilities to the Cloudflare Durable Objects you already own. Persist work, retry failures, and synchronize clients — without generating classes or adopting a workflow engine.

[Get started](/getting-started/) · [Explore the API](/reference/)

## Small capabilities, composed together

| You need to…                                          | Reach for…                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Accept a job, retry it, and retrieve its result       | [`Durability`](/primitives/operations/#durable-operations)   |
| Run named reminders or deferred work                  | [`DurabilityAlarms`](/primitives/alarms/#named-alarms)       |
| Deliver each message independently to several targets | [`DurabilityFanout`](/primitives/fanout/#routing-and-fanout) |
| Keep a stream consumers can rewind                    | [`DurabilityLog`](/primitives/log/#retained-log)             |
| Connect browsers with typed RPC and replayable events | [`DurabilitySocket`](/primitives/socket/#browser-sockets)    |

All durable capabilities store their records in your object's SQLite database. Compose them with one shared scheduler and keep ownership of your class, RPC methods, and application schema.

## Build a complete system

Explore [composition guides](/compositions/) for recurring billing, email delivery, live job dashboards, account-wide concurrency, and replayable streams. Each follows a complete application's data flow, with diagrams showing where a simpler design breaks and what recovers after failure.

Every [primitive](/capabilities/) has its own page, including its API, durable versus in-memory state, and behind-the-scenes execution model.

## Know the contract

- **At least once.** Pass stable idempotency keys to external systems; retries can repeat effects.
- **Acceptance is not completion.** Registration returns after persistence. Read the result separately.
- **Cloudflare-native.** Requires SQLite-backed Durable Objects; this is not a Node.js job runner.
- **Not workflow replay.** Memoized results last only while their work is unsettled.

Read [concepts and guarantees](/concepts/) before connecting a handler to an external system, or [choose a capability](/capabilities/) for the full stable and experimental catalog.
