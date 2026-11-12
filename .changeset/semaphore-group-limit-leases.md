---
'durability': patch
---

Count a group's lease footprint against its `groupLimit` when the semaphore allocates grants. With `limitedGroups: 'withinGroupLimit'`, a group whose ceiling was filled by grants plus leased permits could still receive grants, in every provisioning mode, so more items ran than the group limit allowed. Retired leases stay charged to their group until their client confirms what it drew.
