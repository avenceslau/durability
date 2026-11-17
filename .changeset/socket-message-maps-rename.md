---
'durability': minor
'@durability/tanstack-db': minor
---

Rename the socket's phantom type exports from `durability/client` to say what they carry. This is a breaking rename of type-level API with no runtime change: the symbol is still `Symbol('durability.socket')`.

- `socketShape` → `socketMessageMaps`, the `unique symbol` key whose property type holds a socket's inbound and outbound message maps.
- `SocketShape<Inbound, Outbound>` → `SocketMessageMaps<Inbound, Outbound>`.
- `AnySocketShape` → `AnyDurabilitySocket`, the constraint for any `DurabilitySocket`.

The old names are removed, not aliased; replace them in your imports and type annotations. `@durability/tanstack-db` now constrains `socketCollectionOptions` with `AnyDurabilitySocket`, so upgrade both packages together.
