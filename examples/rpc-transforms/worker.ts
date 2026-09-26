/**
 * `@durability/transforms` example: typed RPC middleware on a Durable Object.
 *
 * A custom `observability` transform carries a request id from the caller to
 * the callee (over promise pipelining, no extra round trip) and records
 * per-method metrics around the handler. Shipped caller transforms compose on
 * the same stub: `timeout` bounds caller wait time and `retry` repeats failed
 * idempotent calls.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  applyTransforms,
  createTransformContextTarget,
  createTransformStub,
  defineTransform,
  registerTransform,
  retry,
  timeout,
} from '@durability/transforms';

type Env = {
  COUNTERS: DurableObjectNamespace<Counter>;
};

type RequestContext = { requestId?: string };

export class Counter extends DurableObject<Env> {
  /** Context transport for caller transforms; see createTransformContextTarget. */
  setContext(context: RequestContext) {
    return createTransformContextTarget(this, context);
  }

  async increment(by: number): Promise<number> {
    const value = ((await this.ctx.storage.get<number>('value')) ?? 0) + by;
    await this.ctx.storage.put('value', value);
    return value;
  }

  async read(): Promise<number> {
    return (await this.ctx.storage.get<number>('value')) ?? 0;
  }
}

/**
 * Caller side contributes the request id; callee side times the handler and
 * logs it together with the context that traveled across the RPC boundary.
 */
const observability = defineTransform<Counter, RequestContext>()
  .caller(
    (requestId: string) =>
      async ({ next }) =>
        next({ context: { requestId } })
  )
  .callee((metric: string) => async ({ method, context, next }) => {
    const startedAt = Date.now();
    try {
      return await next();
    } finally {
      console.log({
        metric,
        method,
        requestId: context.requestId,
        durationMs: Date.now() - startedAt,
      });
    }
  });

// Installs the callee side once, during module initialization.
applyTransforms(Counter, {
  all: [registerTransform(observability, 'counter_rpc')],
});

export default {
  async fetch(request, env): Promise<Response> {
    const requestId =
      request.headers.get('x-request-id') ?? crypto.randomUUID();

    // The Vite plugin (`doTransforms`) wraps configured binding stubs
    // automatically and generates the matching types; `createTransformStub`
    // is the explicit equivalent when building without it.
    const counter = createTransformStub(env.COUNTERS.getByName('global'));

    // Transforms chain in order: attach context-producing transforms first,
    // then generic ones. Here the timeout bounds the retries as a whole.
    const value = await counter
      .with(observability, requestId)
      .with(timeout, 5_000)
      .with(retry, { retries: 2 })
      .increment(1);

    return Response.json({ requestId, value });
  },
} satisfies ExportedHandler<Env>;
