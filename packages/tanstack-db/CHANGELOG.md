# @durability/tanstack-db

## 0.1.0

### Minor Changes

- 83278bf: Add `socketCollectionOptions`: TanStack DB collection options backed by a `durability/client` connection. A snapshot RPC seeds the collection on first subscription and after unreplayable gaps, outbound events are applied as row changes, and optimistic mutations are forwarded to the connection's `rpc` with an `awaitSynced` helper for confirming durable operations.
