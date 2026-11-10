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
      import("./worker").ContextDO
    >;
    PIPELINE_DO: TransformDurableObjectNamespace<
      import("./worker").PipelineDO
    >;
    WORKFLOW: TransformStub<Workflow<Parameters<import("./worker").EchoWorkflow['run']>[0]['payload']>>;
    KV: TransformStub<KVNamespace>;
    BUCKET: TransformStub<R2Bucket>;
    CONTEXT_SERVICE: TransformStub<Service<typeof import("./worker").ContextService>>;
  }

  namespace Cloudflare {
    interface Env {
      CONTEXT_DO: TransformDurableObjectNamespace<
        import("./worker").ContextDO
      >;
      PIPELINE_DO: TransformDurableObjectNamespace<
        import("./worker").PipelineDO
      >;
      WORKFLOW: TransformStub<Workflow<Parameters<import("./worker").EchoWorkflow['run']>[0]['payload']>>;
      KV: TransformStub<KVNamespace>;
      BUCKET: TransformStub<R2Bucket>;
      CONTEXT_SERVICE: TransformStub<Service<typeof import("./worker").ContextService>>;
    }
  }
}

export {};
