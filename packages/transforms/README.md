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

## Caching

`@durability/transforms/cache` caches read methods in tiers, each a caller transform: `memoryTier` keeps results in the caller's isolate, `durableTier` in the calling Durable Object's storage, and `workerCacheTier` answers through the Workers cache, so every caller in a location shares one cached result per Durable Object, method, and arguments, and concurrent misses reach the object once. It is experimental.

Declare which methods to cache next to the Durable Object, in the Worker's main module:

```ts
import { DurableObject } from 'cloudflare:workers';
import { cachePlan } from '@durability/transforms/cache';

export class Account extends DurableObject<Env> {
  async getMetadata(accountId: number): Promise<AccountMetadata> {
    // ...
  }
}

export const accountCache = cachePlan<Account>({ version: 1 })({
  getMetadata: {
    memory: { freshMs: 5_000, staleMs: 60_000 },
    location: { freshMs: 60_000, staleMs: 86_400_000 },
    staleIfErrorMs: 86_400_000,
  },
});
```

Only async methods whose arguments and result round-trip through JSON can be planned; anything else is a type error. Each tier caches only the methods that have windows for it: `freshMs` is how long a result answers without calling the tiers behind it, and `staleMs` is how long it keeps answering while one call refreshes it. Ages count from when the object returned the result, whichever tier holds it. Bump `version` when a cached result changes shape.

With `cacheEntrypoints: true`, the Vite plugin generates a `WorkerEntrypoint` named `AccountReads` (the target's export name followed by `Reads`) for every plan declared at the top level of the main module. Enable the Workers cache for it in Wrangler:

```ts
doTransforms({ wrangler: './wrangler.jsonc', cacheEntrypoints: true });
```

```jsonc
{
  "cache": { "enabled": false, "cross_version_cache": true },
  "exports": {
    "AccountReads": { "type": "worker", "cache": { "enabled": true } },
  },
}
```

The build fails when the entrypoint is missing from `exports` or does not enable the cache. Pass `cachePlan<Account>({ entrypoint: 'Name' })` to rename it, or `entrypoint: false` and write it yourself:

```ts
import { WorkerEntrypoint } from 'cloudflare:workers';
import { serveCached } from '@durability/transforms/cache';

export class AccountReads extends WorkerEntrypoint<Env> {
  fetch(request: Request) {
    return serveCached(request, accountCache, {
      namespace: this.env.ACCOUNTS,
    });
  }
}
```

The generated entrypoint reaches the object through `exports` from `cloudflare:workers`. `@cloudflare/vitest-pool-workers` finds a Worker's exports without running Vite plugins, so list generated entrypoints in its `additionalExports` option.

Callers bind to the entrypoint and attach `workerCacheTier` to stubs of the planned object:

```jsonc
{
  "services": [
    {
      "binding": "ACCOUNT_READS",
      "service": "accounts",
      "entrypoint": "AccountReads",
    },
  ],
}
```

```ts
import { env } from 'cloudflare:workers';
import { workerCacheTier } from '@durability/transforms/cache';
import { accountCache } from 'accounts/cache';

export const accountReads = workerCacheTier(accountCache, {
  binding: () => env.ACCOUNT_READS,
});

const account = env.ACCOUNTS.getByName(String(accountId));

await account.with(accountReads).getMetadata(accountId);
await account.with(accountReads, { cache: 'no-cache' }).getMetadata(accountId);
await account.with(accountReads).setPlan(accountId, 'pro');
```

- Methods outside the plan are called directly. Pass `{ cache: 'no-cache' }` to refresh the cached result before answering, or `{ cache: 'no-store' }` to skip the cache for one call.
- When the cached request fails or takes longer than `timeoutMs` (5 seconds by default), the call goes to the object directly. Set `fallback: 'throw'` to get a `CachedCallError` instead.
- Results come back as JSON whichever path answered, and `onRead` reports which one did, with the `CF-Cache-Status` header when present.
- Calls whose arguments do not encode as JSON, or encode into a URL over 4 KiB, go to the object directly.
- Attach the tier only to stubs of the plan's Durable Object class: transforms do not check the stub's class, and the entrypoint addresses objects by ID in the plan's namespace.
- A cached result can be up to `staleMs` old, so cache only reads that tolerate it. Writes through the object do not update cached results.

### Memory tier

Create a `memoryTier` once at module scope and put it before the Workers cache tier, so each isolate answers from memory and refreshes from its location:

```ts
import { memoryTier } from '@durability/transforms/cache';

export const accountMemory = memoryTier(accountCache, { maxEntries: 10_000 });

await env.ACCOUNTS.getByName(id)
  .with(accountMemory)
  .with(accountReads)
  .getMetadata(accountId);
```

- Concurrent misses for one key share one call to the tiers behind it. A stale entry answers at once while one background call refreshes it.
- When a refresh fails, an entry younger than `staleIfErrorMs` keeps answering.
- Entries are cloned in and out, so changing a result does not change the cache. The least recently used entries are evicted past `maxEntries` (1000 by default).
- Tiers pass entries to each other with their load time, and the stub unwraps them, so the call returns the plain result. Transforms that change results, such as `betterResultCodec`, belong after the cache tiers.

### Durable tier

When the caller is a Durable Object, `durableTier` caches the plan's `durable` methods in its own storage, so cached results survive eviction. Create one per object and put it between the memory and Workers cache tiers:

```ts
import { durableTier } from '@durability/transforms/cache';

export class Invoice extends DurableObject<Env> {
  readonly #accountDurable = durableTier(accountCache, this.ctx.storage);

  getAccount(accountId: number) {
    return this.env.ACCOUNTS.getByName(String(accountId))
      .with(accountMemory)
      .with(this.#accountDurable)
      .with(accountReads)
      .getMetadata(accountId);
  }
}
```

Entries are stored under SHA-256 keys with the `durability-cache:` prefix. Expired entries are deleted when read; entries for calls that are never made again stay in storage until the object deletes them.

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
