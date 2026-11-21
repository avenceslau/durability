# @durability/tanstack-db

## 1.1.0

### Minor Changes

- 2c7f65e: Rename the socket's phantom type exports from `durability/client` to say what they carry. This is a breaking rename of type-level API with no runtime change: the symbol is still `Symbol('durability.socket')`.
  - `socketShape` → `socketMessageMaps`, the `unique symbol` key whose property type holds a socket's inbound and outbound message maps.
  - `SocketShape<Inbound, Outbound>` → `SocketMessageMaps<Inbound, Outbound>`.
  - `AnySocketShape` → `AnyDurabilitySocket`, the constraint for any `DurabilitySocket`.

  The old names are removed, not aliased; replace them in your imports and type annotations. `@durability/tanstack-db` now constrains `socketCollectionOptions` with `AnyDurabilitySocket`, so upgrade both packages together.

## 1.0.1

### Patch Changes

- 661d392: Fix `awaitSynced()` waiting out its full timeout when the confirming event arrived before the RPC answered. The baseline write counts are now taken when the mutation handler starts, not when it calls `awaitSynced()`, so the documented `await rpc.create(...); await awaitSynced();` pattern resolves as soon as the server's event has been applied.

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
