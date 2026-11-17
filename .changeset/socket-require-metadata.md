---
'durability': minor
---

Require `metadata` on a `DurabilitySocket` whose handlers need it. `metadata` was always optional, so a handler annotated with `SocketCall<{ user: string }>` could receive `undefined` when the option was left out. It is now required whenever any handler's `SocketCall<…>` metadata excludes `undefined`, and stays optional when every handler admits `undefined` or declares no metadata. A handler whose metadata is a union such as `User | undefined` no longer collapses the socket's metadata type to `never`, so such a socket can now set `metadata`.

Each WebSocket attachment now records whether its metadata was captured. A connection accepted before the socket had `metadata`, such as one still open from before the deploy that added it, is closed with code `1012` on its next frame, before any handler runs; the browser client reconnects with backoff and the new upgrade captures metadata. Its in-flight call rejects with `SocketConnectionLostError`. Attachments written by earlier versions stay readable and count as captured when they hold metadata.

To migrate, add `metadata` to each socket that no longer compiles, or widen its handlers' annotations to admit `undefined`:

```ts
new DurabilitySocket({
  context: this.ctx,
  inbound: {
    whoami: {
      input: v.undefined(),
      handle: (_input, call: SocketCall<{ user: string }>) =>
        call.metadata.user,
    },
  },
  outbound: {},
  metadata: (request) => ({
    user: request.headers.get('x-user') ?? 'anonymous',
  }),
});
```
