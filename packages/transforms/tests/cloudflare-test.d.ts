import type { TransformStub } from '@durability/transforms';
import type { CrossWorkerContextService } from './cross-worker-service';
import type {
  CacheDO,
  ContextDO,
  ContextService,
  EchoWorkflow,
  PipelineDO,
} from './worker';

interface __BaseEnv_Env {
  CONTEXT_DO: DurableObjectNamespace<ContextDO>;
  CONTEXT_SERVICE: Service<typeof ContextService>;
  PIPELINE_DO: DurableObjectNamespace<PipelineDO>;
  CACHE_DO: DurableObjectNamespace<CacheDO>;
  CACHE_READS: Fetcher;
  KV: KVNamespace;
  BUCKET: R2Bucket;
  WORKFLOW: Workflow<{ value: string }>;
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
