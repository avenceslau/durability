---
'@durability/transforms': minor
---

Narrow `TransformContext` from `Record<string, unknown>` to `Record<string, TransformContextValue>`. A non-empty context reaches the callee through `setContext` over Cloudflare RPC, so its values must survive structured cloning; the type now says so. `TransformContextValue`, newly exported, covers primitives (including `undefined` and `bigint`), `Date`, `RegExp`, `Error`, `ArrayBuffer` and typed-array views, and arrays, `Map`s, `Set`s, and plain objects of those values.

Contexts of strings, numbers, and other plain data compile unchanged. A context type with a field outside that set, such as a function or a class instance, no longer satisfies `defineTransform<Target, Context>()`. To migrate, send serializable data instead, for example an ID the callee resolves to the object. Nested object types inside a context must, like the context itself, be `type` aliases rather than interfaces.
