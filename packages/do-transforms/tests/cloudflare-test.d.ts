import type { TransformStub } from '@repo/do-transforms';
import type { CrossWorkerContextService } from './cross-worker-service';
import type { ContextDO, ContextService } from './test-worker';

interface __BaseEnv_Env {
  CONTEXT_DO: DurableObjectNamespace<ContextDO>;
  CONTEXT_SERVICE: Service<typeof ContextService>;
  CROSS_WORKER_SERVICE: TransformStub<
    Service<typeof CrossWorkerContextService>
  >;
}

declare global {
  interface Env extends __BaseEnv_Env {}

  namespace Cloudflare {
    interface Env extends __BaseEnv_Env {}
  }
}

export {};
