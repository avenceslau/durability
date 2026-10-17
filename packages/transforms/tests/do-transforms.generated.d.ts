import type { TransformStub } from '@durability/transforms';

type TransformDurableObjectNamespace<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
> = Omit<DurableObjectNamespace<T>, 'get' | 'getByName'> & {
  get(
    id: DurableObjectId,
    options?: DurableObjectNamespaceGetDurableObjectOptions
  ): TransformStub<DurableObjectStub<T>>;
  getByName(
    name: string,
    options?: DurableObjectNamespaceGetDurableObjectOptions
  ): TransformStub<DurableObjectStub<T>>;
};

declare global {
  interface Env {
    CONTEXT_DO: TransformDurableObjectNamespace<
      import("./test-worker").ContextDO
    >;
    PIPELINE_DO: TransformDurableObjectNamespace<
      import("./test-worker").PipelineDO
    >;
    WORKFLOW: TransformStub<Workflow<Parameters<import("./test-worker").EchoWorkflow['run']>[0]['payload']>>;
    KV: TransformStub<KVNamespace>;
    BUCKET: TransformStub<R2Bucket>;
    CONTEXT_SERVICE: TransformStub<Service<typeof import("./test-worker").ContextService>>;
  }

  namespace Cloudflare {
    interface Env {
      CONTEXT_DO: TransformDurableObjectNamespace<
        import("./test-worker").ContextDO
      >;
      PIPELINE_DO: TransformDurableObjectNamespace<
        import("./test-worker").PipelineDO
      >;
      WORKFLOW: TransformStub<Workflow<Parameters<import("./test-worker").EchoWorkflow['run']>[0]['payload']>>;
      KV: TransformStub<KVNamespace>;
      BUCKET: TransformStub<R2Bucket>;
      CONTEXT_SERVICE: TransformStub<Service<typeof import("./test-worker").ContextService>>;
    }
  }
}

export {};
