---
title: Experimental options
description: Opt-in APIs and options outside the stable surface.
---

## Experimental options

These options, methods, and capabilities are opt-in: none takes effect unless you set, call, or construct it, so leaving them alone keeps every behavior described above. Their names and behavior may change in a minor release. Scheduler options can also be passed to a helper configured with `context`.

```ts
const scheduler = new DurabilityScheduler({
  context: this.ctx,
  liveTimers: true,
});

const alarms = new DurabilityAlarms({
  scheduler,
  handlers: { tick: async () => this.enqueueDueRuns() },
});

await alarms.tick.cancel();
```

See [scheduler options](/primitives/scheduler/), [alarm cancellation](/primitives/alarms/), and [recurring schedules](/primitives/schedule/).
