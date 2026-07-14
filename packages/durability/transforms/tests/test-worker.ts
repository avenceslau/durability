import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Result } from 'better-result';
import {
  applyTransforms,
  betterResultCodec,
  createTransformContextTarget,
  defineTransform,
  largeObjectStream,
  registerTransform,
} from '@durability/transforms';

export type TestContext = {
  requestId?: string;
};

export class ContextDO extends DurableObject {
  setContext(context: TestContext) {
    return createTransformContextTarget(this, context);
  }

  async greet(name: string): Promise<string> {
    return `Hello, ${name}`;
  }

  async result(): Promise<Result<number, never>> {
    return Result.ok(42);
  }

  async abort(reason: string): Promise<void> {
    this.ctx.abort(reason);
  }

  async largeObject(size: number): Promise<{ payload: string }> {
    return { payload: 'x'.repeat(size) };
  }
}

export const observability = defineTransform<ContextDO, TestContext>()
  .caller(
    (options: { requestId: string }) =>
      async ({ next }) =>
        next({ context: { requestId: options.requestId } })
  )
  .callee((options: { metricName: string }) => async ({ context, next }) => ({
    metricName: options.metricName,
    requestId: context.requestId,
    value: await next(),
  }));

applyTransforms(ContextDO, {
  all: [registerTransform(betterResultCodec)],
  methods: {
    greet: [registerTransform(observability, { metricName: 'do_rpc_calls' })],
    largeObject: [
      registerTransform(largeObjectStream, { thresholdBytes: 128 }),
    ],
  },
});

export class ContextService extends WorkerEntrypoint {
  setContext(context: TestContext) {
    return createTransformContextTarget(this, context);
  }

  async greet(name: string): Promise<string> {
    return `Hello from service, ${name}`;
  }
}

export const serviceObservability = defineTransform<
  ContextService,
  TestContext
>()
  .caller(
    (options: { requestId: string }) =>
      async ({ next }) =>
        next({ context: { requestId: options.requestId } })
  )
  .callee((options: { metricName: string }) => async ({ context, next }) => ({
    metricName: options.metricName,
    requestId: context.requestId,
    value: await next(),
  }));

applyTransforms(ContextService, {
  all: [
    registerTransform(serviceObservability, {
      metricName: 'service_rpc_calls',
    }),
  ],
});

export default {
  fetch() {
    return new Response('ok');
  },
};
