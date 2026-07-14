import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  applyTransforms,
  createTransformContextTarget,
  defineTransform,
  registerTransform,
} from '@durability/transforms';
import type { TestContext } from './test-worker';

export class CrossWorkerContextService extends WorkerEntrypoint {
  setContext(context: TestContext) {
    return createTransformContextTarget(this, context);
  }

  async greet(name: string): Promise<string> {
    return `Hello from another worker, ${name}`;
  }
}

export const crossWorkerObservability = defineTransform<
  CrossWorkerContextService,
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

applyTransforms(CrossWorkerContextService, {
  all: [
    registerTransform(crossWorkerObservability, {
      metricName: 'cross_worker_rpc_calls',
    }),
  ],
});
