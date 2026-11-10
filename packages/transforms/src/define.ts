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

export const reservedRpcMethods = new Set<string>([
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

export type AsyncMethodKey<TTarget extends object> = Exclude<
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

export type EmptyTransformContext = Record<never, never>;

/** Values a transform can add or replace before invoking the next transform. */
export type TransformNextInput<TContext extends TransformContext> = {
  /** Context fields shallow-merged into the fields accumulated so far. */
  context?: Partial<TContext>;
};

type SharedTransformContext<
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

/** Information available while a caller-side transform wraps an RPC method. */
export type CallerTransformContext<
  TTarget extends object,
  TContext extends TransformContext,
> = SharedTransformContext<TTarget, TContext> &
  (TTarget extends Rpc.DurableObjectBranded
    ? {
        /** ID of the Durable Object addressed by the stub. */
        actorId: DurableObjectId;
      }
    : unknown);

type TargetEnv<TTarget extends object> = TTarget extends { env: infer TEnv }
  ? TEnv
  : Cloudflare.Env;

/** Information available while a callee-side transform wraps an RPC method. */
export type CalleeTransformContext<
  TTarget extends object,
  TContext extends TransformContext,
> = SharedTransformContext<TTarget, TContext> & {
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

export type TransformIdentity = {
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

export type CallerOptions<TTransform> = TTransform extends {
  readonly callerFactory: (options: infer TOptions) => unknown;
}
  ? TOptions
  : never;

type CalleeOptions<TTransform> = TTransform extends {
  readonly calleeFactory: (options: infer TOptions) => unknown;
}
  ? TOptions
  : never;

export type TransformOptionsArguments<TOptions> = undefined extends TOptions
  ? [options?: TOptions]
  : [options: TOptions];

export type TransformTargetOf<TTransform> = TTransform extends {
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

export type TransformContextOf<TTransform> = TTransform extends {
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

export type RuntimeTransformContext = {
  method: string;
  args: unknown[];
  context: TransformContext;
  next(input?: TransformNextInput<TransformContext>): Promise<unknown>;
};
