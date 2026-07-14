# @durability/transforms

Typed caller and callee transforms for Cloudflare Durable Object and Worker service-binding RPC.

## Install

```sh
npm install @durability/transforms
```

## Vite setup

The Vite plugin reads the configured Wrangler bindings, wraps matching RPC stubs, and generates declarations that add `.with(...)` to their types.

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

A caller timeout stops waiting but does not cancel the remote operation. Each retry is a new RPC invocation, so retry only idempotent methods or pass an idempotency key.

Other built-ins include:

- `betterResultCodec` to serialize and rehydrate `better-result` values.
- `errorBoundary` to convert caller-visible throws into Better Result errors.
- `abortAsSuccess` to treat expected Durable Object resets as successful undefined results.
- `largeObjectStream` to stream large JSON object results.

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
