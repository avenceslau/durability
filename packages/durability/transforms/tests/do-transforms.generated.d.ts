import type { TransformStub } from '@durability/transforms';

declare global {
  interface DurableObjectNamespace<
    T extends Rpc.DurableObjectBranded | undefined = undefined,
  > {
    get(
      id: DurableObjectId,
      options?: DurableObjectNamespaceGetDurableObjectOptions
    ): TransformStub<DurableObjectStub<T>>;
    getByName(
      name: string,
      options?: DurableObjectNamespaceGetDurableObjectOptions
    ): TransformStub<DurableObjectStub<T>>;
  }

  interface Env {
    CONTEXT_SERVICE: TransformStub<
      Service<typeof import('./test-worker').ContextService>
    >;
  }

  namespace Cloudflare {
    interface Env {
      CONTEXT_SERVICE: TransformStub<
        Service<typeof import('./test-worker').ContextService>
      >;
    }
  }
}

export {};
