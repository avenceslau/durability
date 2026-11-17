import {
  createTransformStub,
  type TransformContext,
  type TransformStub,
} from '@durability/transforms';
import {
  resolveNamespace,
  type DurableObjectTarget,
} from '../durable-object-target.js';
import { RoutingError } from '../errors.js';
import { isObject } from '../predicates.js';
import { RoutingLoad, type EnqueueResult } from './load.js';
import {
  RoutingClient,
  type RoutingClientConfig,
  type Sharding,
} from './client.js';

export type { EnqueueResult, LoadSnapshot, ProcessingLoad } from './load.js';

export type { RoutingAddress, RoutingTarget, Sharding } from './client.js';

export type RoutingSession<Input, Value, Context = unknown> = {
  push(input: Input, context?: Context): Promise<EnqueueResult<Value>>;
  setContext(context: TransformContext): {
    invoke(method: string, args: unknown[]): Promise<EnqueueResult<Value>>;
  };
};

export type DurabilityRoutingConfig<
  Target extends Rpc.DurableObjectBranded,
  Input,
  Value,
  Context = unknown,
> = DurableObjectTarget<Target> & {
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
    const clientConfig: RoutingClientConfig<Input, Value, Context> = {
      invoke: (address, input) => {
        const namespace = resolveNamespace(
          config,
          (message) => new RoutingError(message)
        );

        const stub = namespace.getByName(
          address.shard,
          address.locationHint === undefined
            ? undefined
            : { locationHint: address.locationHint }
        );

        return config.invoke(stub, input);
      },
    };

    if (config.sharding !== undefined) {
      clientConfig.sharding = config.sharding;
    }

    if (config.softBacklogLimit !== undefined) {
      clientConfig.softBacklogLimit = config.softBacklogLimit;
    }

    const client = new RoutingClient<Input, Value, Context>(clientConfig);

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
            (!isObject(positional) || Array.isArray(positional))
          ) {
            throw new TypeError(
              'Routing context must be an object when combined with transform context'
            );
          }

          // SAFETY: the transform stub forwards the arguments of a typed `push`,
          // so args are [Input, Context?]; transform context only adds keys.
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
