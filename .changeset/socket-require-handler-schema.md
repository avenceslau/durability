---
'durability': minor
---

Require a schema for every `DurabilitySocket` inbound handler. Bare function handlers, which received the raw `unknown` input, are removed: each handler is now `{ input, handle }`, and `handle` receives the schema's output, so its parameter no longer needs an annotation and a mismatched one does not compile. Client `rpc` methods take the schema's input type; methods whose input was `unknown` no longer accept an optional `unknown` argument.

Wrap each bare handler in a schema. A method that takes no input uses a schema for `undefined`, and the client still calls it without arguments:

```ts
inbound: {
  // Before: list: () => this.list(),
  list: { input: v.undefined(), handle: () => this.list() },
  // Before: whoami: (_input: unknown, call: SocketCall<Metadata>) => call.metadata.user,
  whoami: {
    input: v.undefined(),
    handle: (_input, call: SocketCall<Metadata>) => call.metadata.user,
  },
  // Before: echo: (input) => input,
  echo: { input: v.unknown(), handle: (input) => input },
},
```

Use `v.unknown()` only when a handler really accepts any value. A method with a `v.undefined()` schema now rejects calls that send an input with `SocketInputError`, where a bare handler ignored it. The wire protocol, error frames, and channels are unchanged.
