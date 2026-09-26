import { exports as workerExports } from 'cloudflare:workers';
import {
  createTransformStub,
  type TransformContext,
  type TransformStub,
} from '@durability/transforms';
import { RoutingError } from './errors.js';
import { RoutingLoad, type EnqueueResult } from './load.js';
import { RoutingClient, type Sharding } from './routing-client.js';

export type { EnqueueResult, LoadSnapshot, ProcessingLoad } from './load.js';
export type {
  RoutingAddress,
  RoutingTarget,
  Sharding,
} from './routing-client.js';

export type RoutingSession<Input, Value, Context = unknown> = {
  push(input: Input, context?: Context): Promise<EnqueueResult<Value>>;
  setContext(context: TransformContext): {
    invoke(method: string, args: unknown[]): Promise<unknown>;
  };
};

export type DurabilityRoutingConfig<
  Target extends Rpc.DurableObjectBranded,
  Input,
  Value,
  Context = unknown,
> = {
  /** Application-owned exported Durable Object class. */
  target: { prototype: Target };
  /** Injected by the Vite plugin; explicit for builds without it. */
  exportName?: string;
  /** Explicit namespace escape hatch for cross-worker or non-Vite consumers. */
  namespace?: () => DurableObjectNamespace<Target>;
  /** Chooses the application method/capability to invoke; never hardcoded. */
  invoke(
    stub: DurableObjectStub<Target>,
    input: Input
  ): Promise<EnqueueResult<Value>>;
  sharding?: Sharding<Input, Context>;
  softBacklogLimit?: number;
};

/**
 * Inside a DO, attach this local load observer to a fanout capability. Outside
 * the DO, client() routes calls to an application-owned class using ordinary
 * @durability/transforms caller transforms. No DO classes are generated.
 */
export class DurabilityRouting extends RoutingLoad {
  static client<
    Target extends Rpc.DurableObjectBranded,
    Input,
    Value,
    Context = unknown,
  >(
    config: DurabilityRoutingConfig<Target, Input, Value, Context>
  ): TransformStub<RoutingSession<Input, Value, Context>> {
    const client = new RoutingClient<Input, Value, Context>({
      invoke: (address, input) => {
        let namespace = config.namespace?.();
        if (!namespace) {
          if (!config.exportName) {
            throw new RoutingError(
              'Use the durability Vite plugin, exportName, or an explicit namespace to resolve the routing target'
            );
          }
          const exported: unknown = Reflect.get(
            workerExports,
            config.exportName
          );
          if (
            exported === null ||
            (typeof exported !== 'object' && typeof exported !== 'function') ||
            typeof Reflect.get(exported, 'getByName') !== 'function'
          ) {
            throw new RoutingError(
              `Export "${config.exportName}" is not a Durable Object namespace`
            );
          }
          namespace = exported as DurableObjectNamespace<Target>;
        }
        const stub = namespace.getByName(
          address.shard,
          address.locationHint === undefined
            ? undefined
            : { locationHint: address.locationHint }
        );
        return config.invoke(stub, input);
      },
      ...(config.sharding === undefined ? {} : { sharding: config.sharding }),
      ...(config.softBacklogLimit === undefined
        ? {}
        : { softBacklogLimit: config.softBacklogLimit }),
    });

    const session: RoutingSession<Input, Value, Context> = {
      push: (input, context) => client.push(input, context),
      setContext: (context) => ({
        invoke: (method, args) => {
          if (method !== 'push') {
            throw new RoutingError(`Unknown routing method "${method}"`);
          }
          const positional: unknown = args[1];
          if (
            positional !== undefined &&
            (positional === null ||
              typeof positional !== 'object' ||
              Array.isArray(positional))
          ) {
            throw new TypeError(
              'Routing context must be an object when combined with transform context'
            );
          }
          return client.push(
            args[0] as Input,
            { ...positional, ...context } as Context
          );
        },
      }),
    };
    return createTransformStub(session);
  }
}
