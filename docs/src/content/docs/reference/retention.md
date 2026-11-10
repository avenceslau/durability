---
title: Retention and purge
description: Retention and purge for durable capabilities.
---

## Destructive retention purge

`purgeBefore(timestamp)` on either helper deletes that helper's records on its own `channel` created strictly before `timestamp`, regardless of status, and returns the count. Records created exactly at the cutoff are retained.

```ts
const removedOperations = await this.durability.purgeBefore(retentionCutoff);
const removedAlarms = await this.alarms.purgeBefore(retentionCutoff);
```

The purge runs in one transaction. It best-effort aborts matching active handlers, but cannot force an abort-ignoring handler to stop. Operation IDs can be reused immediately; a late old generation cannot overwrite the replacement record.
