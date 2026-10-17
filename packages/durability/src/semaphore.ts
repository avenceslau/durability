import {
  createTransformStub,
  type TransformContext,
  type TransformStub,
} from '@durability/transforms';
import {
  resolveNamespace,
  type DurableObjectTarget,
} from './durable-object-target.js';
import { SemaphoreProtocolError } from './errors.js';
import { SemaphoreClient } from './semaphore-client.js';
import {
  type PermitGrant,
  type PermitRequest,
  type PermitSync,
  type PermitSyncResult,
  type SemaphoreRequest,
  type SemaphoreResponse,
} from './semaphore-protocol.js';
import { DurabilitySemaphoreServer } from './semaphore-server.js';

export type {
  GrantReport,
  GrantResult,
  PermitGrant,
  PermitRequest,
  PermitSync,
  PermitSyncResult,
  SemaphoreBlockedReason,
  SemaphoreRequest,
  SemaphoreResponse,
} from './semaphore-protocol.js';
export type {
  SemaphoreAddress,
  SemaphoreClientConfig,
} from './semaphore-client.js';
export { SemaphoreClient } from './semaphore-client.js';
export type {
  DurabilitySemaphoreConfig,
  DurabilitySemaphoreEvent,
  SemaphoreUsage,
} from './semaphore-server.js';
export type {
  SemaphoreLeaseOptions,
  SemaphoreProvisioning,
} from './semaphore-leases.js';
export {
  DurabilitySemaphoreQueue,
  type AdmittedItem,
  type DurabilitySemaphoreQueueConfig,
  type DurabilitySemaphoreQueueEvent,
  type SemaphoreHolder,
  type SemaphoreInput,
  type SemaphoreItemStatus,
} from './semaphore-queue.js';

export type SemaphoreSession = {
  request(key: string, message: PermitRequest): Promise<PermitGrant>;
  sync(key: string, message: PermitSync): Promise<PermitSyncResult>;
  setContext(context: TransformContext): {
    invoke(method: string, args: unknown[]): Promise<unknown>;
  };
};

export type DurabilitySemaphoreClientConfig<
  Target extends Rpc.DurableObjectBranded,
> = DurableObjectTarget<Target> & {
  /** Chooses the application RPC method that forwards to `handle`; never hardcoded. */
  invoke(
    stub: DurableObjectStub<Target>,
    message: SemaphoreRequest
  ): Promise<SemaphoreResponse>;
  locationHint?: (key: string) => DurableObjectLocationHint | undefined;
};

/**
 * Inside a DO, holds one concurrency limit for many client Durable Objects.
 * Outside the DO, `client()` routes semaphore messages to the application-owned
 * holder class by key using ordinary @durability/transforms caller transforms.
 */
export class DurabilitySemaphore extends DurabilitySemaphoreServer {
  /**
   * Routes semaphore messages to the application-owned holder class by key.
   * Caller transforms such as `timeout` apply; transform context is not used.
   */
  static client<Target extends Rpc.DurableObjectBranded>(
    config: DurabilitySemaphoreClientConfig<Target>
  ): TransformStub<SemaphoreSession> {
    const client = new SemaphoreClient({
      invoke: (address, message) => {
        const namespace = resolveNamespace(
          config,
          (text) => new SemaphoreProtocolError(text)
        );
        const stub = namespace.getByName(
          address.key,
          address.locationHint === undefined
            ? undefined
            : { locationHint: address.locationHint }
        );
        return config.invoke(stub, message);
      },
      ...(config.locationHint === undefined
        ? {}
        : { locationHint: config.locationHint }),
    });

    const session: SemaphoreSession = {
      request: (key, message) => client.request(key, message),
      sync: (key, message) => client.sync(key, message),
      setContext: () => ({
        invoke: (method, args) => {
          const key = args[0] as string;
          if (method === 'request') {
            return client.request(key, args[1] as PermitRequest);
          }
          if (method === 'sync') {
            return client.sync(key, args[1] as PermitSync);
          }
          throw new SemaphoreProtocolError(
            `Unknown semaphore method "${method}"`
          );
        },
      }),
    };
    return createTransformStub(session);
  }
}
