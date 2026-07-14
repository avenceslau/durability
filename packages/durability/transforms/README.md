# @durability/transforms

Typed caller and callee transforms for Cloudflare Durable Object and Worker service-binding RPC.

## Install

```sh
npm install @durability/transforms
```

## Vite setup

The Vite plugin requires Wrangler, reads its validated binding configuration, wraps matching RPC stubs, and generates declarations that add `.with(...)` to their types.

```ts
import { defineConfig } from 'vite';
import { doTransforms } from '@durability/transforms/vite';

export default defineConfig({
  plugins: [doTransforms({ wrangler: './wrangler.jsonc' })],
});
```

The generated declaration defaults to `do-transforms.generated.d.ts` beside the Wrangler `main` module. Include that file in the application's TypeScript project.

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
