# @durability/tanstack-db

## 1.0.0

### Patch Changes

- Updated dependencies [281b7fd]
- Updated dependencies [281b7fd]
- Updated dependencies [c4ec65f]
- Updated dependencies [7173122]
  - durability@5.0.0

## 0.1.0

### Minor Changes

- 83278bf: Add `socketCollectionOptions`: TanStack DB collection options backed by a `durability/client` connection. A snapshot RPC seeds the collection on first subscription and after unreplayable gaps, outbound events are applied as row changes, and optimistic mutations are forwarded to the connection's `rpc` with an `awaitSynced` helper for confirming durable operations.
