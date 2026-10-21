# @durability/transforms

Typed caller and callee transforms for Cloudflare Durable Object and Worker service-binding RPC.

## Install

```sh
npm install @durability/transforms
```

## Vite setup

The Vite plugin requires Wrangler, reads its validated binding configuration, wraps Durable Object stubs and every other object binding (services, KV, R2, Workflows, queues, and so on), and generates declarations that add `.with(...)` to their Wrangler-inferred types. Vars, secrets, and module blobs are left untouched. Bindings whose type Wrangler cannot infer, such as cross-Worker services, are wrapped at runtime but keep their hand-written declarations.

```ts
const value = await env.CACHE.with(timeout, 1_000).get('key');
await env.MEDIA.with(retry, 2).put('file.txt', body);
const instance = await env.JOBS.with(timeout, 5_000).create({ params });
```

Caller transforms run on the client only. Callee transforms and caller context still require a Durable Object or WorkerEntrypoint that you own.

Without transforms, wrapped bindings behave exactly like the originals, including synchronous methods and RPC promise pipelining. With transforms, every call returns a promise that still supports pipelined access such as `stub.with(timeout, 1_000).counter().increment()`; the chained call waits for the transformed result instead of sharing its round trip. Methods on returned objects, such as a `WorkflowInstance`, are not transformed.

For `DurabilityRouting.client({...})` and `DurabilitySemaphore.client({...})`, the plugin injects `exportName` from the targeted Durable Object's same-module export. The target must be a local class exported by that module and declared as a local Durable Object class in Wrangler (including migration classes). Export aliases are supported:

```ts
import { DurableObject } from 'cloudflare:workers';
import { DurabilityRouting as Routing } from 'durability/routing';

class InternalMailbox extends DurableObject {
  enqueue(input: string) {}
}
export { InternalMailbox as Mailbox };

const router = Routing.client({
  target: InternalMailbox,
  invoke: (stub, input) => stub.enqueue(input),
  ...defaults,
});
```

The resulting `exportName` is appended after the other properties, so a spread cannot override it. Lookup is intentionally limited to class declarations and exports visible in the same Worker module; imported classes, re-exports, dynamic targets, and non-inline configs are left alone or rejected when the target is visible. Set `exportName` explicitly as the escape hatch for those cases. Explicit `exportName` values are never changed.

```ts
import { defineConfig } from 'vite';
import { doTransforms } from '@durability/transforms/vite';

export default defineConfig({
  plugins: [doTransforms({ wrangler: './wrangler.jsonc' })],
});
```

The generated declaration defaults to `do-transforms.generated.d.ts` beside the Wrangler `main` module. Include that file in the application's TypeScript project.

### Restore broken Durable Object stubs

Many Durable Object errors leave a stub broken, so every later call through it fails with the same error. Enable `restoreBrokenStubs` to have the plugin rewrite configured namespace `get` and `getByName` calls so the resulting stub replaces itself after a call throws:

```ts
doTransforms({ wrangler: './wrangler.jsonc', restoreBrokenStubs: true });
```

The failed call still rejects and is not retried. The next call obtains a new stub from the namespace with the original arguments, which are evaluated only once, so `env.MY_DO.get(env.MY_DO.newUniqueId())` keeps addressing the same object. The replacement happens at the end of the caller transform chain, so each attempt made by `retry` runs on a fresh stub. Without the plugin, use `createRestorableStubFactory(env.MY_DO, 'getByName')(name)`.

## Define and install a transform

```ts
import { DurableObject } from 'cloudflare:workers';
import {
  applyTransforms,
  createTransformContextTarget,
  defineTransform,
  registerTransform,
} from '@durability/transforms';

type RequestContext = { requestId?: string };

class ExampleObject extends DurableObject {
  setContext(context: RequestContext) {
    return createTransformContextTarget(this, context);
  }

  async greet(name: string) {
    return `Hello, ${name}`;
  }
}

const observability = defineTransform<ExampleObject, RequestContext>()
  .caller(
    (requestId: string) =>
      async ({ next }) =>
        next({ context: { requestId } })
  )
  .callee((metricName: string) => async ({ context, next }) => {
    console.log(metricName, context.requestId);
    return next();
  });

applyTransforms(ExampleObject, {
  methods: {
    greet: [registerTransform(observability, 'greet_calls')],
  },
});

const stub = env.EXAMPLE.getByName('example').with(
  observability,
  crypto.randomUUID()
);

await stub.greet('Ada');
```

`applyTransforms` mutates the class prototype and is cumulative. Call it once during module initialization, not per request or instance.

Caller transforms defined for a Durable Object class also receive `actorId`, the `DurableObjectId` of the object addressed by the stub. Transforms defined for other targets, such as `defineTransform<object>()`, do not see the field, and a Durable Object transform cannot be attached to a binding that is not a Durable Object stub. The ID stays on the caller and is not sent to the callee:

```ts
const actorLog = defineTransform<ExampleObject>().caller(
  () =>
    async ({ actorId, method, next }) => {
      console.log('rpc', method, actorId.toString());
      return next();
    }
);

await env.EXAMPLE.getByName('example').with(actorLog).greet('Ada');
```

Transform context is untrusted caller metadata. It is suitable for request IDs, tracing, and hints, but it must not be accepted as proof of identity, tenancy, roles, or authorization. Derive authorization from independently authenticated data on the callee.

## Built-in caller transforms

```ts
import { retry, timeout } from '@durability/transforms';

const value = await stub
  .with(timeout, 5_000)
  .with(retry, {
    retries: 3,
    delay: ({ attempt }) => Math.min(1_000 * 2 ** (attempt - 1), 30_000),
  })
  .read();
```

A caller timeout stops waiting but does not cancel the remote operation. Each retry is a new RPC invocation, so retry only idempotent methods or pass an idempotency key. When `delay` is omitted, retries use capped exponential backoff with full jitter.

Other built-ins include:

- `betterResultCodec` to serialize and rehydrate `better-result` values in a versioned envelope. Legacy 0.1.0 payloads are rejected by default because their shape is ambiguous; temporarily set `acceptLegacy: true` only while communicating with an older callee.
- `errorBoundary` to convert caller-visible throws into Better Result errors.
- `abortAsSuccess` to treat expected Durable Object resets as successful undefined results.
- `largeObjectStream` to transfer large JSON object results. It requires a Standard Schema validator and enforces a caller decode limit, but it still buffers the complete serialized representation; use native streams for unbounded data.

## Manual wrapping

When the Vite plugin is unavailable, wrap a target or namespace directly:

```ts
import {
  createTransformStub,
  timeout,
  withTransforms,
} from '@durability/transforms';

const service = createTransformStub(env.MY_SERVICE).with(timeout, 5_000);
const namespace = withTransforms(env.MY_DURABLE_OBJECT);
const id = namespace.idFromName('example');
const object = namespace.get(id).with(timeout, 5_000);
```
