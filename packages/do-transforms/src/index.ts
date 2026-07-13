import { RpcTarget } from 'cloudflare:workers';
import { Result, ResultDeserializationError } from 'better-result';
import type { Result as BetterResult } from 'better-result';

type AsyncMethod = (...args: never[]) => Promise<unknown>;

type AsyncMethodKey<TTarget extends object> = {
  [TKey in keyof TTarget]-?: TTarget[TKey] extends AsyncMethod ? TKey : never;
}[keyof TTarget] &
  string;

export type TransformContext = Record<string, unknown>;

export type TransformNextInput<TContext extends TransformContext> = {
  context?: Partial<TContext>;
};

export type CallerTransformContext<
  TTarget extends object,
  TContext extends TransformContext,
> = {
  method: AsyncMethodKey<TTarget>;
  args: unknown[];
  context: TContext;
  next(input?: TransformNextInput<TContext>): Promise<unknown>;
};

type TargetEnv<TTarget extends object> = TTarget extends { env: infer TEnv }
  ? TEnv
  : Cloudflare.Env;

export type CalleeTransformContext<
  TTarget extends object,
  TContext extends TransformContext,
> = CallerTransformContext<TTarget, TContext> & {
  instance: TTarget;
  env: TargetEnv<TTarget>;
  state: unknown;
};

export type CallerTransformHandler<
  TTarget extends object,
  TContext extends TransformContext,
> = (context: CallerTransformContext<TTarget, TContext>) => Promise<unknown>;

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

type RequireSetContext<TTarget, TTransform> =
  keyof TransformContextOf<TTransform> extends never
    ? unknown
    : TTarget extends {
          setContext(context: TransformContextOf<TTransform>): unknown;
        }
      ? unknown
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

export function defineTransform<
  TTarget extends object,
  TContext extends TransformContext = TransformContext,
>(): TransformBuilder<TTarget, TContext> {
  return {
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
  } as TransformBuilder<TTarget, TContext>;
}

export type RegisteredTransform<TTransform extends TransformIdentity> = {
  readonly type: 'registered-do-transform';
  readonly transform: TTransform;
  readonly options: CalleeOptions<TTransform>;
};

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

export type TransformWith<TTarget extends object> = {
  with<TTransform>(
    transform: TTransform &
      TransformIdentity &
      RequireSetContext<TTarget, TTransform> & {
        callerFactory: (options: CallerOptions<TTransform>) => unknown;
      },
    ...options: TransformOptionsArguments<CallerOptions<TTransform>>
  ): TransformStub<ApplyCallerResult<TTarget, TTransform>>;
};

export type TransformStub<TTarget extends object> = {
  [TKey in Exclude<keyof TTarget, 'with'>]: TTarget[TKey];
} & TransformWith<TTarget>;

type NamespaceLike<TTarget extends object> = {
  get(...args: never[]): TTarget;
};

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

          return createTransformStub(target, [
            ...transforms,
            transform.callerFactory(options) as ConfiguredCallerTransform,
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

            const contextualTarget = (
              stub as {
                setContext(context: TransformContext): {
                  invoke(method: string, args: unknown[]): Promise<unknown>;
                };
              }
            ).setContext(context);
            return contextualTarget.invoke(property, initialArgs);
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
  const state = installedTransforms.get(Object.getPrototypeOf(instance));
  const original = state?.originals.get(method);
  if (!state || !original) {
    throw new TypeError(`Unable to dispatch ${method}`);
  }

  const transforms = [...state.all, ...(state.methods.get(method) ?? [])];
  const run = (
    index: number,
    currentContext: TransformContext
  ): Promise<unknown> => {
    const transform = transforms[index];
    if (!transform) {
      return Promise.resolve(original.apply(instance, args));
    }

    const target = instance as Record<string, unknown>;
    return transform({
      instance,
      method,
      args,
      context: currentContext,
      env: target.env,
      state: target.ctx,
      next: (input) =>
        run(index + 1, {
          ...currentContext,
          ...input?.context,
        }),
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

export class TransformContextTarget<
  TTarget extends object,
  TContext extends TransformContext,
> extends RpcTarget {
  constructor(instance: TTarget, context: TContext) {
    super();
    transformContextTargets.set(this, { instance, context });
  }

  invoke(method: string, args: unknown[]): Promise<unknown> {
    const target = transformContextTargets.get(this);
    if (!target) {
      throw new TypeError('Unable to resolve transform context target');
    }

    return dispatchWithContext(target.instance, method, args, target.context);
  }
}

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

type RuntimeCalleeRegistration = {
  readonly type: 'registered-do-transform';
  readonly transform: TransformIdentity & {
    calleeFactory?: (options: unknown) => unknown;
  };
  readonly options: unknown;
};

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

    for (const method of Object.getOwnPropertyNames(prototype)) {
      if (method === 'constructor' || method === 'setContext') {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
      if (!descriptor || typeof descriptor.value !== 'function') {
        continue;
      }

      installed.originals.set(method, descriptor.value);
      Object.defineProperty(prototype, method, {
        ...descriptor,
        value: function (this: object, ...args: unknown[]) {
          return dispatchWithContext(this, method, args, {});
        },
      });
    }
  }

  const configure = ({ transform, options }: RuntimeCalleeRegistration) => {
    if (!transform.calleeFactory) {
      throw new TypeError('Transform does not define a callee');
    }
    return transform.calleeFactory(options) as ConfiguredCalleeTransform;
  };

  installed.all.push(
    ...(config.all ?? []).map((registration) =>
      configure(registration as RuntimeCalleeRegistration)
    )
  );

  for (const [method, registrations] of Object.entries(config.methods ?? {})) {
    if (!installed.originals.has(method)) {
      throw new TypeError(
        `Cannot apply transforms to unknown method ${method}`
      );
    }
    const methodTransforms = installed.methods.get(method) ?? [];
    methodTransforms.push(
      ...registrations.map((registration) =>
        configure(registration as RuntimeCalleeRegistration)
      )
    );
    installed.methods.set(method, methodTransforms);
  }

  return targetClass;
}

type EmptyTransformContext = Record<never, never>;

export const betterResultCodec = Object.assign(
  defineTransform<object, EmptyTransformContext>()
    .caller((_options: void) => async ({ next }) => {
      const value = await next();
      const result = Result.deserialize(value);

      if (
        Result.isError(result) &&
        ResultDeserializationError.is(result.error)
      ) {
        return value;
      }

      return result;
    })
    .callee((_options: void) => async ({ next }) => {
      const value = await next();
      if (
        typeof value !== 'object' ||
        value === null ||
        !('status' in value) ||
        (value.status !== 'ok' && value.status !== 'error')
      ) {
        return value;
      }

      return Result.serialize(value as BetterResult<unknown, unknown>);
    }),
  { callerResult: 'better-result-codec' as const }
);

export class CallerTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`RPC call to ${method} timed out after ${timeoutMs}ms`);
    this.name = 'CallerTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

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

export type LargeObjectStreamOptions = {
  thresholdBytes?: number;
};

const largeObjectStreamHeader = new TextEncoder().encode(
  'do-transforms-large-object-v1'
);

export const largeObjectStream = defineTransform<
  object,
  EmptyTransformContext
>()
  .caller((_options: void) => async ({ next }) => {
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

    const decoder = new TextDecoder();
    let json = decoder.decode(
      (first.value as Uint8Array).subarray(largeObjectStreamHeader.byteLength),
      { stream: true }
    );
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Stream chunks must be decoded in order.
      const chunk = await reader.read();
      if (chunk.done) {
        json += decoder.decode();
        break;
      }
      json += decoder.decode(chunk.value, { stream: true });
    }

    return JSON.parse(json) as unknown;
  })
  .callee((options: LargeObjectStreamOptions | undefined) => {
    const thresholdBytes = options?.thresholdBytes ?? 32 * 1024 * 1024;
    if (!Number.isInteger(thresholdBytes) || thresholdBytes <= 0) {
      throw new RangeError('thresholdBytes must be a positive integer');
    }

    return async ({ next }) => {
      const value = await next();
      if (typeof value !== 'object' || value === null) {
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

export type RetryOptions = {
  retries: number;
  baseDelayMs?: number;
  exponential?: boolean;
};

export const retry = defineTransform<object, EmptyTransformContext>().caller(
  (options: RetryOptions | number) =>
    async ({ next }) => {
      const {
        retries,
        baseDelayMs = 0,
        exponential = false,
      } = typeof options === 'number' ? { retries: options } : options;

      if (!Number.isInteger(retries) || retries < 0) {
        throw new RangeError('retries must be a non-negative integer');
      }
      if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
        throw new RangeError(
          'baseDelayMs must be a non-negative finite number'
        );
      }

      for (let attempt = 0; ; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop -- Retry attempts must run sequentially.
          return await next();
        } catch (error) {
          if (attempt >= retries) {
            throw error;
          }

          if (baseDelayMs > 0) {
            const delay = exponential
              ? baseDelayMs * 2 ** attempt
              : baseDelayMs;
            // eslint-disable-next-line no-await-in-loop -- Backoff must finish before the next attempt.
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
    }
);
