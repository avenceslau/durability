---
'durability': minor
---

`DurabilitySemaphore` can hand clients leases — blocks of permits drawn locally with no round trip — with three provisioning modes: `strict` (leases share the limit with grants, grants first), `under` (a reserve inside the limit is kept for leases), and `over` (a separate budget above the limit). `DurabilitySemaphoreQueue` draws from leases for queued items, treats drawn permits as one-shot, and reports `drawn`/`released` high-water marks through its outbox channel; `AdmittedItem.via` reports whether an item was admitted through a grant or a lease.
