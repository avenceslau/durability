---
'durability': minor
---

Type the results of callbacks that the helpers await but ignore as `void | Promise<void>` instead of `unknown`. This covers `DurableAlarmHandler`, fanout `deliver`, outbox `publish`, schedule `run` and `onOutcome`, semaphore queue `admit`, topology `deliver`, and the topology publisher's `write` and `delete` (now `Promise<void>`). Runtime behaviour is unchanged: these results were always discarded, and the new types make that explicit.

A callback that returns a value now fails to typecheck. Wrap its body in a block and await instead of returning, for example `admit: async (items) => { await Promise.all(items.map(start)); }` instead of `admit: (items) => Promise.all(items.map(start))`.
