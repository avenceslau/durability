---
'@durability/transforms': minor
---

Type `createRestorableStubFactory`'s arguments. The namespace is now `RestorableNamespace | undefined`, newly exported, which every Durable Object namespace binding satisfies, and the method is `'get' | 'getByName'`, the two calls the Vite plugin rewrites. Passing an `unknown` value or another method name no longer type-checks; pass the namespace binding itself. Runtime behaviour is unchanged: a missing namespace or method still returns `undefined`.
