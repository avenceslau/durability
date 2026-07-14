import { RpcTarget } from 'cloudflare:workers';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Err, Ok, Result, ResultDeserializationError } from 'better-result';
import type { Result as BetterResult } from 'better-result';

type AsyncMethod = (...args: never[]) => Promise<unknown>;

type ReservedRpcMethod =
  | 'alarm'
  | 'connect'
  | 'email'
  | 'fetch'
  | 'queue'
  | 'scheduled'
  | 'setContext'
  | 'tail'
  | 'tailStream'
  | 'test'
  | 'trace'
  | 'webSocketClose'
  | 'webSocketError'
  | 'webSocketMessage';

const platformPrototypeNames = new Set([
  'DurableObject',
  'Object',
  'RpcTarget',
  'WorkerEntrypoint',
]);

const reservedRpcMethods = new Set<string>([
  'alarm',
  'connect',
  'email',
  'fetch',
  'queue',
  'scheduled',
  'setContext',
  'tail',
  'tailStream',
  'test',
  'trace',
  'webSocketClose',
  'webSocketError',
  'webSocketMessage',
]);

type AsyncMethodKey<TTarget extends object> = Exclude<
  {
    [TKey in keyof TTarget]-?: TTarget[TKey] extends AsyncMethod ? TKey : never;
  }[keyof TTarget] &
    string,
  ReservedRpcMethod
>;

/**
 * Metadata accumulated by caller transforms and optionally sent across RPC.
 *
 * Context is shallow-merged as each transform calls `next`. If the final context
 * is non-empty, the target must expose `setContext` and every value must be
 * supported by Cloudflare RPC serialization. Context is untrusted caller input;
 * never use it directly as proof of identity, tenancy, roles, or authorization.
 */
export type TransformContext = Record<string, unknown>;

type EmptyTransformContext = Record<never, never>;

/** Values a transform can add or replace before invoking the next transform. */
export type TransformNextInput<TContext extends TransformContext> = {
  /** Context fields shallow-merged into the fields accumulated so far. */
  context?: Partial<TContext>;
};

/** Information available while a caller-side transform wraps an RPC method. */
export type CallerTransformContext<
  TTarget extends object,
  TContext extends TransformContext,
> = {
  /** Name of the asynchronous target method being called. */
  method: AsyncMethodKey<TTarget>;
  /** Arguments originally passed to the target method. */
  args: unknown[];
  /** Context accumulated by earlier caller transforms. */
  context: TContext;
  /** Continues the transform chain and eventually invokes the RPC method. */
  next(input?: TransformNextInput<TContext>): Promise<unknown>;
};

type TargetEnv<TTarget extends object> = TTarget extends { env: infer TEnv }
  ? TEnv
  : Cloudflare.Env;

/** Information available while a callee-side transform wraps an RPC method. */
export type CalleeTransformContext<
  TTarget extends object,
  TContext extends TransformContext,
> = CallerTransformContext<TTarget, TContext> & {
  /** Durable Object or WorkerEntrypoint instance receiving the call. */
  instance: TTarget;
  /** Environment bindings exposed by the receiving instance. */
  env: TargetEnv<TTarget>;
  /** Receiving instance context, such as `DurableObjectState`. */
  state: unknown;
};

/** A configured caller-side transform handler. */
export type CallerTransformHandler<
  TTarget extends object,
  TContext extends TransformContext,
> = (context: CallerTransformContext<TTarget, TContext>) => Promise<unknown>;

/** A configured callee-side transform handler. */
export type CalleeTransformHandler<
  TTarget extends object,
  TContext extends TransformContext,
> = (context: CalleeTransformContext<TTarget, TContext>) => Promise<unknown>;

type TransformIdentity = {
  readonly type: 'do-transform';
  readonly callerResult?:
    | 'better-result-codec'
    | 'better-result'
    | 'abort-as-success';
};

type CallerTransformDefinition<
  TTarget extends object,
  TContext extends TransformContext,
  TOptions,
> = TransformIdentity & {
  readonly callerFactory: (
    options: TOptions
  ) => CallerTransformHandler<TTarget, TContext>;
};

type CalleeTransformDefinition<
  TTarget extends object,
  TContext extends TransformContext,
  TOptions,
> = TransformIdentity & {
  readonly calleeFactory: (
    options: TOptions
  ) => CalleeTransformHandler<TTarget, TContext>;
};

type CallerOptions<TTransform> = TTransform extends {
  readonly callerFactory: (options: infer TOptions) => unknown;
}
  ? TOptions
  : never;

type CalleeOptions<TTransform> = TTransform extends {
  readonly calleeFactory: (options: infer TOptions) => unknown;
}
  ? TOptions
  : never;

type TransformOptionsArguments<TOptions> = undefined extends TOptions
  ? [options?: TOptions]
  : [options: TOptions];

type TransformTargetOf<TTransform> = TTransform extends {
  readonly calleeFactory: (
    ...args: never[]
  ) => CalleeTransformHandler<infer TTarget, infer _TContext>;
}
  ? TTarget
  : TTransform extends {
        readonly callerFactory: (
          ...args: never[]
        ) => CallerTransformHandler<infer TTarget, infer _TContext>;
      }
    ? TTarget
    : never;

type TransformContextOf<TTransform> = TTransform extends {
  readonly calleeFactory: (
    ...args: never[]
  ) => CalleeTransformHandler<infer _TTarget, infer TContext>;
}
  ? TContext
  : TTransform extends {
        readonly callerFactory: (
          ...args: never[]
        ) => CallerTransformHandler<infer _TTarget, infer TContext>;
      }
    ? TContext
    : never;

type TransformContextInvoker = {
  invoke(method: string, args: unknown[]): Promise<unknown>;
};

type RequireSetContext<TTarget, TTransform> =
  keyof TransformContextOf<TTransform> extends never
    ? unknown
    : TTarget extends {
          setContext(
            context: TransformContextOf<TTransform>
          ): infer ContextTarget;
        }
      ? Awaited<ContextTarget> extends TransformContextInvoker
        ? unknown
        : { readonly setContextMustReturnTransformTarget: never }
      : { readonly setContextRequired: never };

type TransformBuilder<
  TTarget extends object,
  TContext extends TransformContext,
> = {
  caller<TCallerOptions>(
    factory: (
      options: TCallerOptions
    ) => CallerTransformHandler<TTarget, TContext>
  ): CallerTransformDefinition<TTarget, TContext, TCallerOptions> & {
    callee<TCalleeOptions>(
      factory: (
        options: TCalleeOptions
      ) => CalleeTransformHandler<TTarget, TContext>
    ): CallerTransformDefinition<TTarget, TContext, TCallerOptions> &
      CalleeTransformDefinition<TTarget, TContext, TCalleeOptions>;
  };
  callee<TCalleeOptions>(
    factory: (
      options: TCalleeOptions
    ) => CalleeTransformHandler<TTarget, TContext>
  ): CalleeTransformDefinition<TTarget, TContext, TCalleeOptions> & {
    caller<TCallerOptions>(
      factory: (
        options: TCallerOptions
      ) => CallerTransformHandler<TTarget, TContext>
    ): CalleeTransformDefinition<TTarget, TContext, TCalleeOptions> &
      CallerTransformDefinition<TTarget, TContext, TCallerOptions>;
  };
};

/**
 * Defines a typed transform with a caller side, a callee side, or both.
 *
 * Factories receive configuration when the transform is attached. Caller and
 * callee configuration types are independent. A context-producing caller
 * requires the target class to expose a compatible `setContext` method.
 *
 * @example
 * ```ts
 * type RequestContext = { requestId?: string };
 *
 * const observability = defineTransform<MyDurableObject, RequestContext>()
 *   .caller((requestId: string) => async ({ next }) =>
 *     next({ context: { requestId } })
 *   )
 *   .callee((metricName: string) => async ({ context, next }) => {
 *     console.log(metricName, context.requestId);
 *     return next();
 *   });
 * ```
 */
export function defineTransform<
  TTarget extends object,
  TContext extends TransformContext = EmptyTransformContext,
>(): TransformBuilder<TTarget, TContext> {
  const builder: TransformBuilder<TTarget, TContext> = {
    caller(callerFactory) {
      return {
        type: 'do-transform',
        callerFactory,
        callee(calleeFactory) {
          return { type: 'do-transform', callerFactory, calleeFactory };
        },
      };
    },
    callee(calleeFactory) {
      return {
        type: 'do-transform',
        calleeFactory,
        caller(callerFactory) {
          return { type: 'do-transform', callerFactory, calleeFactory };
        },
      };
    },
  };
  return builder;
}

/** A callee transform paired with the options used to install it. */
export type RegisteredTransform<TTransform extends TransformIdentity> = {
  /** Discriminator consumed by {@link applyTransforms}. */
  readonly type: 'registered-do-transform';
  /** Transform definition containing the callee factory. */
  readonly transform: TTransform;
  /** Options passed to the callee factory during installation. */
  readonly options: CalleeOptions<TTransform>;
};

/**
 * Configures the callee side of a transform for {@link applyTransforms}.
 *
 * @example
 * ```ts
 * applyTransforms(MyDurableObject, {
 *   all: [registerTransform(observability, 'rpc_calls')],
 * });
 * ```
 */
export function registerTransform<TTransform extends TransformIdentity>(
  transform: TTransform & {
    calleeFactory: (options: CalleeOptions<TTransform>) => unknown;
  },
  ...options: TransformOptionsArguments<CalleeOptions<TTransform>>
): RegisteredTransform<TTransform> {
  if (!transform.calleeFactory) {
    throw new TypeError('Transform does not define a callee');
  }

  return {
    type: 'registered-do-transform',
    transform,
    options: options[0] as CalleeOptions<TTransform>,
  };
}

type TransformCallerResult<TResult, TTransform> = TTransform extends {
  readonly callerResult: 'better-result-codec';
}
  ? TResult extends BetterResult<infer TValue, infer TError>
    ? BetterResult<TValue, TError>
    : BetterResult<unknown, unknown>
  : TTransform extends {
        readonly callerResult: 'better-result';
      }
    ? BetterResult<TResult, unknown>
    : TTransform extends {
          readonly callerResult: 'abort-as-success';
        }
      ? BetterResult<TResult | undefined, never>
      : TResult;

type ApplyCallerResult<TTarget extends object, TTransform> = {
  [TKey in Exclude<keyof TTarget, 'with'>]: TTarget[TKey] extends (
    ...args: infer TArgs
  ) => Promise<infer TResult>
    ? (...args: TArgs) => Promise<TransformCallerResult<TResult, TTransform>>
    : TTarget[TKey];
};

/** Adds the typed `.with(transform, options)` method to an RPC target. */
export type TransformWith<TTarget extends object> = {
  /** Returns a new stub with the caller transform appended to its chain. */
  with<TTransform>(
    transform: TTransform &
      TransformIdentity &
      RequireSetContext<TTarget, TTransform> & {
        callerFactory: (options: CallerOptions<TTransform>) => unknown;
      },
    ...options: TransformOptionsArguments<CallerOptions<TTransform>>
  ): TransformStub<ApplyCallerResult<TTarget, TTransform>>;
};

/**
 * An RPC target that preserves the target API and supports caller transforms.
 *
 * `.with` does not mutate the original stub. Each call returns a new proxy whose
 * transforms run in the order they were appended.
 */
export type TransformStub<TTarget extends object> = {
  [TKey in Exclude<keyof TTarget, 'with'>]: TTarget[TKey];
} & TransformWith<TTarget>;

type NamespaceLike<TTarget extends object> = {
  get(...args: never[]): TTarget;
};

/** A Durable Object namespace whose `get` method returns transformable stubs. */
export type TransformNamespace<TNamespace extends NamespaceLike<object>> = Omit<
  TNamespace,
  'get'
> & {
  get(
    ...args: Parameters<TNamespace['get']>
  ): TransformStub<ReturnType<TNamespace['get']>>;
};

type RuntimeTransformContext = {
  method: string;
  args: unknown[];
  context: TransformContext;
  next(input?: TransformNextInput<TransformContext>): Promise<unknown>;
};

type ConfiguredCallerTransform = (
  context: RuntimeTransformContext
) => Promise<unknown>;

/**
 * Wraps an RPC target with caller-side transform support.
 *
 * The Vite plugin inserts this wrapper automatically for configured Durable
 * Object and service bindings. Call it directly when the plugin is unavailable
 * or when wrapping an RPC-like object in tests.
 *
 * @example
 * ```ts
 * const stub = createTransformStub(env.MY_SERVICE).with(timeout, 5_000);
 * const value = await stub.read();
 * ```
 */
export function createTransformStub<TTarget extends object>(
  target: TTarget,
  transforms: ConfiguredCallerTransform[] = []
): TransformStub<TTarget> {
  return new Proxy(target, {
    get(stub, property, receiver) {
      if (property === 'with') {
        return (
          transform: TransformIdentity & {
            callerFactory?: (options: unknown) => unknown;
          },
          options?: unknown
        ) => {
          if (!transform.callerFactory) {
            throw new TypeError('Transform does not define a caller');
          }

          const configured = transform.callerFactory(options);
          if (typeof configured !== 'function') {
            throw new TypeError(
              'Caller transform factory must return a function'
            );
          }

          return createTransformStub(target, [
            ...transforms,
            (context) =>
              Promise.resolve(Reflect.apply(configured, undefined, [context])),
          ]);
        };
      }

      const value = Reflect.get(stub, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') {
        return value;
      }

      return (...initialArgs: unknown[]) => {
        const run = (
          index: number,
          context: TransformContext
        ): Promise<unknown> => {
          const transform = transforms[index];
          if (!transform) {
            if (Object.keys(context).length === 0) {
              return Promise.resolve(
                Reflect.apply(
                  value as (...args: unknown[]) => unknown,
                  stub,
                  initialArgs
                )
              );
            }

            const setContext = Reflect.get(stub, 'setContext');
            if (typeof setContext !== 'function') {
              throw new TypeError(
                'Cannot send transform context to a target without setContext'
              );
            }

            const contextualTarget: unknown = Reflect.apply(setContext, stub, [
              context,
            ]);
            if (
              (typeof contextualTarget !== 'object' &&
                typeof contextualTarget !== 'function') ||
              contextualTarget === null
            ) {
              throw new TypeError(
                'setContext must return a transform context target'
              );
            }
            const invoke = Reflect.get(contextualTarget, 'invoke');
            if (typeof invoke !== 'function') {
              throw new TypeError(
                'setContext must return a target with an invoke method'
              );
            }
            return Reflect.apply(invoke, contextualTarget, [
              property,
              initialArgs,
            ]);
          }

          return transform({
            method: property,
            args: initialArgs,
            context,
            next: (input) =>
              run(index + 1, {
                ...context,
                ...input?.context,
              }),
          });
        };

        return run(0, {});
      };
    },
  }) as TransformStub<TTarget>;
}

/**
 * Wraps a Durable Object namespace so every stub returned by `get` is
 * transformable.
 *
 * Prefer the Vite plugin for application code because it also updates generated
 * binding types. This helper is useful for manual integration and tests.
 *
 * @example
 * ```ts
 * const namespace = withTransforms(env.MY_DURABLE_OBJECT);
 * const stub = namespace.get(id).with(timeout, 5_000);
 * ```
 */
export function withTransforms<TNamespace extends NamespaceLike<object>>(
  namespace: TNamespace
): TransformNamespace<TNamespace> {
  return new Proxy(namespace, {
    get(target, property, receiver) {
      if (property !== 'get') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return (...args: Parameters<TNamespace['get']>) =>
        createTransformStub(target.get(...args), []);
    },
  }) as unknown as TransformNamespace<TNamespace>;
}

type DOClass<TTarget extends object> = abstract new (
  ...args: never[]
) => TTarget;

type ConfiguredCalleeTransform = (
  context: RuntimeTransformContext & {
    instance: object;
    env: unknown;
    state: unknown;
  }
) => Promise<unknown>;

type InstalledTransforms = {
  all: ConfiguredCalleeTransform[];
  methods: Map<string, ConfiguredCalleeTransform[]>;
  originals: Map<string, (...args: unknown[]) => unknown>;
};

const installedTransforms = new WeakMap<object, InstalledTransforms>();

function dispatchWithContext(
  instance: object,
  method: string,
  args: unknown[],
  context: TransformContext
): Promise<unknown> {
  if (reservedRpcMethods.has(method)) {
    throw new TypeError(`Cannot dispatch reserved method ${method}`);
  }

  const states: InstalledTransforms[] = [];
  let currentPrototype: object | null = Object.getPrototypeOf(instance);
  while (currentPrototype) {
    const state = installedTransforms.get(currentPrototype);
    if (state?.originals.has(method)) {
      states.push(state);
    }
    currentPrototype = Object.getPrototypeOf(currentPrototype);
  }

  const original = states[0]?.originals.get(method);
  if (!original) {
    throw new TypeError(`Unable to dispatch ${method}`);
  }

  const transforms = [...states]
    .reverse()
    .flatMap((state) => [...state.all, ...(state.methods.get(method) ?? [])]);
  const run = (
    index: number,
    currentContext: TransformContext
  ): Promise<unknown> => {
    const transform = transforms[index];
    if (!transform) {
      return Promise.resolve(original.apply(instance, args));
    }

    return transform({
      instance,
      method,
      args,
      context: currentContext,
      env: Reflect.get(instance, 'env'),
      state: Reflect.get(instance, 'ctx'),
      next: (input) =>
        run(
          index + 1,
          input?.context
            ? { ...currentContext, ...input.context }
            : currentContext
        ),
    });
  };

  return run(0, context);
}

const transformContextTargets = new WeakMap<
  object,
  {
    instance: object;
    context: TransformContext;
  }
>();

/**
 * RPC target that carries caller context to the original callee instance.
 *
 * Applications normally return this from a class's `setContext` method through
 * {@link createTransformContextTarget}; callers should not construct it directly.
 */
export class TransformContextTarget<
  TTarget extends object,
  TContext extends TransformContext,
> extends RpcTarget {
  constructor(instance: TTarget, context: TContext) {
    super();
    transformContextTargets.set(this, { instance, context });
  }

  /** Dispatches a pipelined method call with the context captured by this target. */
  invoke(method: string, args: unknown[]): Promise<unknown> {
    const target = transformContextTargets.get(this);
    if (!target) {
      throw new TypeError('Unable to resolve transform context target');
    }

    return dispatchWithContext(target.instance, method, args, target.context);
  }
}

/**
 * Creates the `RpcTarget` used to continue a call with caller-provided context.
 *
 * A target only needs `setContext` when one of its caller transforms adds
 * context. Cloudflare promise pipelining lets the caller invoke the returned
 * target without another explicit application-level round trip.
 *
 * @example
 * ```ts
 * class MyDurableObject extends DurableObject {
 *   setContext(context: RequestContext) {
 *     return createTransformContextTarget(this, context);
 *   }
 * }
 * ```
 */
export function createTransformContextTarget<
  TTarget extends object,
  TContext extends TransformContext,
>(
  instance: TTarget,
  context: TContext
): TransformContextTarget<TTarget, TContext> {
  return new TransformContextTarget(instance, context);
}

type DOTransformContext<TTarget> = TTarget extends {
  setContext(context: infer TContext): unknown;
}
  ? TContext
  : never;

type ValidateRegisteredTransform<TTarget extends object, TRegistration> =
  TRegistration extends RegisteredTransform<infer TTransform>
    ? TTarget extends TransformTargetOf<TTransform>
      ? keyof TransformContextOf<TTransform> extends never
        ? TRegistration
        : [DOTransformContext<TTarget>] extends [never]
          ? never
          : DOTransformContext<TTarget> extends TransformContextOf<TTransform>
            ? TRegistration
            : never
      : never
    : never;

type ValidateRegisteredTransforms<
  TTarget extends object,
  TRegistrations extends readonly unknown[],
> = {
  [TKey in keyof TRegistrations]: ValidateRegisteredTransform<
    TTarget,
    TRegistrations[TKey]
  >;
};

type ValidateMethodTransforms<
  TTarget extends object,
  TMethods extends Record<string, readonly unknown[]>,
> = {
  [TMethod in keyof TMethods]: TMethod extends AsyncMethodKey<TTarget>
    ? ValidateRegisteredTransforms<TTarget, TMethods[TMethod]>
    : never;
};

/**
 * Installs callee transforms on a Durable Object or WorkerEntrypoint class.
 *
 * Installation mutates the class prototype and is cumulative, so call this once
 * during module initialization rather than per request or per instance. Global
 * transforms run first, followed by transforms registered for the invoked method.
 * `setContext` is reserved for context transport and is never wrapped.
 *
 * @example
 * ```ts
 * applyTransforms(MyDurableObject, {
 *   all: [registerTransform(betterResultCodec)],
 *   methods: {
 *     greet: [registerTransform(observability, 'greet_calls')],
 *   },
 * });
 * ```
 */
export function applyTransforms<
  TClass extends DOClass<object>,
  const TAll extends readonly unknown[] = readonly [],
  const TMethods extends Record<string, readonly unknown[]> = {},
>(
  targetClass: TClass,
  config: {
    all?: TAll & ValidateRegisteredTransforms<InstanceType<TClass>, TAll>;
    methods?: TMethods &
      ValidateMethodTransforms<InstanceType<TClass>, TMethods>;
  }
): TClass {
  const prototype = targetClass.prototype;
  let installed = installedTransforms.get(prototype);

  if (!installed) {
    installed = {
      all: [],
      methods: new Map(),
      originals: new Map(),
    };
    installedTransforms.set(prototype, installed);

    const methods = new Map<
      string,
      {
        descriptor: PropertyDescriptor;
        original: (...args: unknown[]) => unknown;
      }
    >();
    let currentPrototype: object | null = prototype;
    while (currentPrototype) {
      const constructorValue = Reflect.get(currentPrototype, 'constructor');
      const constructorName =
        typeof constructorValue === 'function'
          ? constructorValue.name
          : undefined;
      if (
        currentPrototype !== prototype &&
        constructorName !== undefined &&
        platformPrototypeNames.has(constructorName)
      ) {
        break;
      }

      const inheritedState = installedTransforms.get(currentPrototype);
      for (const method of Object.getOwnPropertyNames(currentPrototype)) {
        if (methods.has(method) || reservedRpcMethods.has(method)) {
          continue;
        }

        const descriptor = Object.getOwnPropertyDescriptor(
          currentPrototype,
          method
        );
        const inheritedOriginal = inheritedState?.originals.get(method);
        const candidate = inheritedOriginal ?? descriptor?.value;
        if (
          !descriptor ||
          typeof candidate !== 'function' ||
          (!inheritedOriginal && candidate.constructor.name !== 'AsyncFunction')
        ) {
          continue;
        }
        methods.set(method, { descriptor, original: candidate });
      }
      currentPrototype = Object.getPrototypeOf(currentPrototype);
    }

    for (const [method, { descriptor, original }] of methods) {
      installed.originals.set(method, original);
      Object.defineProperty(prototype, method, {
        ...descriptor,
        value: function (this: object, ...args: unknown[]) {
          return dispatchWithContext(this, method, args, {});
        },
      });
    }
  }

  const configure = (registration: unknown): ConfiguredCalleeTransform => {
    if (typeof registration !== 'object' || registration === null) {
      throw new TypeError('Invalid transform registration');
    }
    const transform = Reflect.get(registration, 'transform');
    if (typeof transform !== 'object' || transform === null) {
      throw new TypeError('Invalid transform registration');
    }
    const calleeFactory = Reflect.get(transform, 'calleeFactory');
    if (typeof calleeFactory !== 'function') {
      throw new TypeError('Transform does not define a callee');
    }
    const configured: unknown = Reflect.apply(calleeFactory, transform, [
      Reflect.get(registration, 'options'),
    ]);
    if (typeof configured !== 'function') {
      throw new TypeError('Callee transform factory must return a function');
    }
    return (context) =>
      Promise.resolve(Reflect.apply(configured, undefined, [context]));
  };

  installed.all.push(...(config.all ?? []).map(configure));

  for (const [method, registrations] of Object.entries(config.methods ?? {})) {
    if (!installed.originals.has(method)) {
      throw new TypeError(
        `Cannot apply transforms to unknown method ${method}`
      );
    }
    const methodTransforms = installed.methods.get(method) ?? [];
    methodTransforms.push(...registrations.map(configure));
    installed.methods.set(method, methodTransforms);
  }

  return targetClass;
}

const betterResultEnvelopeKey = '__durability_transforms_better_result_v1';

/** Caller compatibility options for {@link betterResultCodec}. */
export type BetterResultCodecOptions = {
  /** Decode unmarked responses emitted by version 0.1.0. Defaults to true. */
  acceptLegacy?: boolean;
};

/**
 * Serializes Better Result values on the callee and rehydrates them on the caller.
 *
 * New responses use a versioned envelope so ordinary domain objects with an
 * `ok` or `error` status pass through unchanged. Set `acceptLegacy` only while
 * callers still communicate with version 0.1.0 callees.
 *
 * @example
 * ```ts
 * applyTransforms(MyDurableObject, {
 *   all: [registerTransform(betterResultCodec)],
 * });
 *
 * const result = await stub.with(betterResultCodec).read();
 * ```
 */
export const betterResultCodec = Object.assign(
  defineTransform<object, EmptyTransformContext>()
    .caller(
      (options: BetterResultCodecOptions | undefined) =>
        async ({ next }) => {
          const value = await next();
          if (typeof value === 'object' && value !== null) {
            const envelope = Reflect.get(value, betterResultEnvelopeKey);
            if (typeof envelope === 'object' && envelope !== null) {
              if (Reflect.get(envelope, 'version') !== 1) {
                throw new TypeError(
                  'Unsupported Better Result envelope version'
                );
              }
              const result = Result.deserialize(
                Reflect.get(envelope, 'result')
              );
              if (
                Result.isError(result) &&
                ResultDeserializationError.is(result.error)
              ) {
                throw new TypeError('Invalid Better Result envelope');
              }
              return result;
            }
          }

          if (options?.acceptLegacy !== false) {
            const legacy = Result.deserialize(value);
            if (
              !Result.isError(legacy) ||
              !ResultDeserializationError.is(legacy.error)
            ) {
              return legacy;
            }
          }
          return value;
        }
    )
    .callee((_options: void) => async ({ next }) => {
      const value = await next();
      if (!(value instanceof Ok) && !(value instanceof Err)) {
        return value;
      }

      const serialized = Result.serialize(value);
      return {
        ...serialized,
        [betterResultEnvelopeKey]: { version: 1, result: serialized },
      };
    }),
  { callerResult: 'better-result-codec' as const }
);

/**
 * Error thrown when a caller-side timeout expires.
 *
 * The remote RPC is not cancelled; only the caller stops waiting for it.
 */
export class CallerTimeoutError extends Error {
  /** RPC method whose caller deadline expired. */
  readonly method: string;
  /** Configured caller deadline in milliseconds. */
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`RPC call to ${method} timed out after ${timeoutMs}ms`);
    this.name = 'CallerTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Rejects a caller RPC with {@link CallerTimeoutError} after a deadline.
 *
 * This transform does not abort the remote method. Use it to bound caller wait
 * time, not as a guarantee that remote work or side effects stopped.
 *
 * @example
 * ```ts
 * await stub.with(timeout, 5_000).read();
 * ```
 */
export const timeout = defineTransform<object, EmptyTransformContext>().caller(
  (timeoutMs: number) =>
    async ({ method, next }) => {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new RangeError('timeoutMs must be a non-negative finite number');
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          next(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new CallerTimeoutError(method, timeoutMs)),
              timeoutMs
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    }
);

/**
 * Converts caller-visible throws into `better-result` error values.
 *
 * @example
 * ```ts
 * const result = await stub.with(errorBoundary).read();
 * if (Result.isError(result)) {
 *   console.error(result.error);
 * }
 * ```
 */
export const errorBoundary = Object.assign(
  defineTransform<object, EmptyTransformContext>().caller(
    (_options: void) =>
      async ({ next }) => {
        try {
          return Result.ok(await next());
        } catch (error) {
          return Result.err(error);
        }
      }
  ),
  { callerResult: 'better-result' as const }
);

/**
 * Converts Cloudflare Durable Object reset errors into successful undefined
 * Better Results while preserving ordinary errors.
 *
 * Use this only when a reset is an expected success condition for the method.
 */
export const abortAsSuccess = Object.assign(
  defineTransform<object, EmptyTransformContext>().caller(
    (_options: void) =>
      async ({ next }) => {
        try {
          return Result.ok(await next());
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'durableObjectReset' in error &&
            error.durableObjectReset === true
          ) {
            return Result.ok(undefined);
          }

          throw error;
        }
      }
  ),
  { callerResult: 'abort-as-success' as const }
);

/** Callee configuration for {@link largeObjectStream}. */
export type LargeObjectStreamOptions = {
  /** Encoded size that switches an object result to streaming. Defaults to 32 MiB. */
  thresholdBytes?: number;
};

/** Caller configuration for {@link largeObjectStream}. */
export type LargeObjectStreamCallerOptions = {
  /** Maximum encoded payload accepted by the caller. Defaults to 64 MiB. */
  maxDecodeBytes?: number;
  /** Runtime validator for the reconstructed JSON value. */
  schema: StandardSchemaV1<unknown, unknown>;
};

/** Error thrown when a streamed object exceeds the caller's decode limit. */
export class LargeObjectDecodeLimitError extends Error {
  constructor(readonly maxDecodeBytes: number) {
    super(`Large object stream exceeded ${maxDecodeBytes} bytes`);
    this.name = 'LargeObjectDecodeLimitError';
  }
}

/** Error thrown when a streamed object fails runtime schema validation. */
export class LargeObjectValidationError extends Error {
  constructor(readonly issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super('Large object stream failed schema validation');
    this.name = 'LargeObjectValidationError';
  }
}

const largeObjectStreamHeader = new TextEncoder().encode(
  'do-transforms-large-object-v1'
);

/**
 * Streams large JSON object results and reconstructs them on the caller.
 *
 * Install the callee side with the desired threshold and attach the caller side
 * to the stub. Existing `ReadableStream` results pass through unchanged. Object
 * values use JSON serialization, so non-JSON values do not round-trip. The
 * transform bypasses RPC value-size limits but still buffers the complete JSON
 * representation; use native streams for unbounded data.
 *
 * @example
 * ```ts
 * applyTransforms(MyDurableObject, {
 *   methods: {
 *     snapshot: [
 *       registerTransform(largeObjectStream, { thresholdBytes: 1_000_000 }),
 *     ],
 *   },
 * });
 *
 * const snapshot = await stub.with(largeObjectStream, {
 *   schema: snapshotSchema,
 * }).snapshot();
 * ```
 */
export const largeObjectStream = defineTransform<
  object,
  EmptyTransformContext
>()
  .caller((options: LargeObjectStreamCallerOptions) => {
    const maxDecodeBytes = options.maxDecodeBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(maxDecodeBytes) || maxDecodeBytes <= 0) {
      throw new RangeError('maxDecodeBytes must be a positive safe integer');
    }

    return async ({ next }) => {
      const value = await next();
      if (!(value instanceof ReadableStream)) {
        return value;
      }

      const reader = value.getReader();
      const first = await reader.read();
      const isEncoded =
        !first.done &&
        first.value instanceof Uint8Array &&
        first.value.byteLength >= largeObjectStreamHeader.byteLength &&
        largeObjectStreamHeader.every(
          (byte, index) => byte === first.value[index]
        );

      if (!isEncoded) {
        let firstPending = true;
        return new ReadableStream<unknown>({
          async pull(controller) {
            const chunk = firstPending ? first : await reader.read();
            firstPending = false;
            if (chunk.done) {
              controller.close();
            } else {
              controller.enqueue(chunk.value);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
      }

      const decoder = new TextDecoder('utf-8', { fatal: true });
      const firstPayload = first.value.subarray(
        largeObjectStreamHeader.byteLength
      );
      let decodedBytes = firstPayload.byteLength;
      if (decodedBytes > maxDecodeBytes) {
        const error = new LargeObjectDecodeLimitError(maxDecodeBytes);
        void reader.cancel(error);
        throw error;
      }

      try {
        let json = decoder.decode(firstPayload, { stream: true });
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- Stream chunks must be decoded in order.
          const chunk = await reader.read();
          if (chunk.done) {
            json += decoder.decode();
            break;
          }
          if (!(chunk.value instanceof Uint8Array)) {
            throw new TypeError('Large object stream chunks must be bytes');
          }
          decodedBytes += chunk.value.byteLength;
          if (decodedBytes > maxDecodeBytes) {
            throw new LargeObjectDecodeLimitError(maxDecodeBytes);
          }
          json += decoder.decode(chunk.value, { stream: true });
        }

        const parsed: unknown = JSON.parse(json);
        const result = await options.schema['~standard'].validate(parsed);
        if (result.issues) {
          throw new LargeObjectValidationError(result.issues);
        }
        return result.value;
      } catch (error) {
        void reader.cancel(error);
        throw error;
      }
    };
  })
  .callee((options: LargeObjectStreamOptions | undefined) => {
    const thresholdBytes = options?.thresholdBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes <= 0) {
      throw new RangeError('thresholdBytes must be a positive safe integer');
    }

    return async ({ next }) => {
      const value = await next();
      if (
        typeof value !== 'object' ||
        value === null ||
        value instanceof ReadableStream
      ) {
        return value;
      }

      const json = JSON.stringify(value);
      if (json === undefined) {
        return value;
      }

      const bytes = new TextEncoder().encode(json);
      if (bytes.byteLength < thresholdBytes) {
        return value;
      }

      let offset = -1;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === -1) {
            controller.enqueue(largeObjectStreamHeader);
            offset = 0;
            return;
          }

          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }

          const end = Math.min(offset + 64 * 1024, bytes.byteLength);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      });
    };
  });

/** Configuration for the caller-side {@link retry} transform. */
export type RetryOptions = {
  /** Number of retries after the initial call. */
  retries: number;
  /** Returns the delay before the next call; `attempt` is one-based. */
  delay?: (context: {
    /** Error thrown by the preceding call. */
    error: unknown;
    /** One-based retry attempt about to be scheduled. */
    attempt: number;
  }) => number | Promise<number>;
};

/**
 * Repeats a failed RPC sequentially according to a caller-side retry policy.
 *
 * Each retry is a new RPC invocation. Only use this with idempotent methods or
 * pass an idempotency key, because the caller cannot know whether a failed call
 * performed remote side effects before its error was observed.
 *
 * @example
 * ```ts
 * await stub.with(retry, {
 *   retries: 3,
 *   delay: ({ attempt }) => Math.min(1_000 * 2 ** (attempt - 1), 30_000),
 * }).write({ idempotencyKey: 'write:123' });
 * ```
 */
export const retry = defineTransform<object, EmptyTransformContext>().caller(
  (options: RetryOptions | number) =>
    async ({ next }) => {
      const { retries, delay } =
        typeof options === 'number' ? { retries: options } : options;

      if (!Number.isInteger(retries) || retries < 0) {
        throw new RangeError('retries must be a non-negative integer');
      }

      for (let attempt = 0; ; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop -- Retry attempts must run sequentially.
          return await next();
        } catch (error) {
          if (attempt >= retries) {
            throw error;
          }

          const retryAttempt = attempt + 1;
          const pendingDelay = delay
            ? delay({ error, attempt: retryAttempt })
            : Math.random() * Math.min(100 * 2 ** (retryAttempt - 1), 30_000);
          // eslint-disable-next-line no-await-in-loop -- Retry delays may depend on the current failure.
          const delayMs = await pendingDelay;
          if (!Number.isFinite(delayMs) || delayMs < 0) {
            throw new RangeError(
              'retry delay must be a non-negative finite number'
            );
          }
          if (delayMs > 0) {
            // eslint-disable-next-line no-await-in-loop -- Backoff must finish before the next attempt.
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }
    }
);
