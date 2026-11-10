import type { Result as BetterResult } from 'better-result';
import type {
  CallerOptions,
  RuntimeTransformContext,
  TransformContext,
  TransformContextOf,
  TransformIdentity,
  TransformOptionsArguments,
  TransformTargetOf,
} from './define.js';

type TransformContextInvoker = {
  invoke(method: string, args: unknown[]): Promise<unknown>;
};

// A transform typed for a Durable Object reads `actorId`, so it may only be
// attached to a stub that carries one. The tuple keeps a union target from
// passing when only some members are Durable Object stubs.
type RequireDurableObjectStub<TTarget, TTransform> =
  TransformTargetOf<TTransform> extends Rpc.DurableObjectBranded
    ? [TTarget] extends [{ readonly id: DurableObjectId }]
      ? unknown
      : { readonly durableObjectTransformRequiresDurableObjectStub: never }
    : unknown;

type RequireSetContext<TTarget, TTransform> =
  keyof TransformContextOf<TTransform> extends never
    ? unknown
    : TTarget extends {
          setContext(context: infer AcceptedContext): infer ContextTarget;
        }
      ? TransformContextOf<TTransform> extends AcceptedContext
        ? ContextTarget extends TransformContextInvoker
          ? unknown
          : { readonly setContextMustReturnTransformTarget: never }
        : { readonly setContextMustAcceptTransformContext: never }
      : { readonly setContextRequired: never };

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

// Transformed calls are always asynchronous. Transforms that keep the result
// type preserve each async method's declared signature, which keeps overloads
// and pipelined RpcPromise types intact. `setContext` is excluded because
// context transport never goes through caller transforms.
type ApplyCallerResult<
  TTarget extends object,
  TTransform,
> = TTransform extends {
  readonly callerResult: string;
}
  ? {
      [TKey in Exclude<keyof TTarget, 'with'>]: TKey extends 'setContext'
        ? TTarget[TKey]
        : TTarget[TKey] extends (...args: infer TArgs) => infer TResult
          ? (
              ...args: TArgs
            ) => Promise<TransformCallerResult<Awaited<TResult>, TTransform>>
          : TTarget[TKey];
    }
  : {
      [TKey in Exclude<keyof TTarget, 'with'>]: TKey extends 'setContext'
        ? TTarget[TKey]
        : TTarget[TKey] extends (...args: never[]) => PromiseLike<unknown>
          ? TTarget[TKey]
          : TTarget[TKey] extends (...args: infer TArgs) => infer TResult
            ? (...args: TArgs) => Promise<Awaited<TResult>>
            : TTarget[TKey];
    };

/** Adds the typed `.with(transform, options)` method to an RPC target. */
export type TransformWith<TTarget extends object> = {
  /** Returns a new stub with the caller transform appended to its chain. */
  with<TTransform>(
    transform: TTransform &
      TransformIdentity &
      RequireSetContext<TTarget, TTransform> &
      RequireDurableObjectStub<TTarget, TTransform> & {
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

type ConfiguredCallerTransform = (
  context: RuntimeTransformContext & {
    actorId: DurableObjectId | undefined;
  }
) => Promise<unknown>;

type PipelineNode = {
  resolve(): Promise<unknown>;
  call(args: unknown[]): Promise<unknown>;
};

/** Shared by a stub and every `.with` view of it so a restore reaches all of them. */
type StubSource<TTarget extends object> = {
  stub: TTarget;
  broken: boolean;
  reopen?: () => TTarget;
};

function currentStub<TTarget extends object>(
  source: StubSource<TTarget>
): TTarget {
  if (source.broken && source.reopen) {
    source.stub = source.reopen();
    source.broken = false;
  }
  return source.stub;
}

/**
 * Emulates RpcPromise pipelining for transformed calls. Transforms must observe
 * the settled result, so a pipelined member access or call waits for it and then
 * runs against the resolved value instead of sharing the original round trip.
 */
function pipelined(node: PipelineNode): unknown {
  return new Proxy(() => {}, {
    get(_target, property) {
      if (
        property === 'then' ||
        property === 'catch' ||
        property === 'finally'
      ) {
        const promise = node.resolve();
        const method = Reflect.get(promise, property) as (
          ...args: unknown[]
        ) => unknown;
        return method.bind(promise);
      }
      if (typeof property === 'symbol') {
        return undefined;
      }

      let member: Promise<unknown> | undefined;
      return pipelined({
        resolve: () =>
          (member ??= node
            .resolve()
            .then((value) => (value as Record<string, unknown>)[property])),
        call: (args) =>
          node.resolve().then((value) => {
            const target = value as Record<string, unknown>;
            return Reflect.apply(
              target[property] as (...args: unknown[]) => unknown,
              target,
              args
            );
          }),
      });
    },
    apply(_target, _thisArg, args) {
      return pipelinedPromise(node.call(args));
    },
  });
}

function pipelinedPromise(promise: Promise<unknown>): unknown {
  return pipelined({
    resolve: () => promise,
    call: (args) =>
      promise.then((value) =>
        Reflect.apply(value as (...args: unknown[]) => unknown, undefined, args)
      ),
  });
}

/**
 * Wraps an RPC target or binding with caller-side transform support.
 *
 * The Vite plugin inserts this wrapper automatically for configured bindings.
 * Call it directly when the plugin is unavailable or when wrapping an RPC-like
 * object in tests.
 *
 * Without transforms, calls pass through unchanged, preserving synchronous
 * methods and RpcPromise pipelining. With transforms, every method call returns
 * a promise that still supports pipelined member access and calls.
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
  if (
    (typeof target !== 'object' && typeof target !== 'function') ||
    target === null
  ) {
    return target;
  }

  return createSourceStub({ stub: target, broken: false }, transforms);
}

/**
 * Returns a `get`-like function whose transformable stubs replace themselves
 * after a call throws, because many Durable Object errors leave a stub broken.
 *
 * The failed call is not retried; the next call, including one made by the
 * {@link retry} transform, uses a stub freshly obtained from the namespace with
 * the original arguments. The Vite plugin inserts this for namespace `get` and
 * `getByName` calls when `restoreBrokenStubs` is enabled.
 *
 * Returns `undefined` when the namespace or method is missing so rewritten
 * optional calls keep short-circuiting.
 *
 * @example
 * ```ts
 * const stub = createRestorableStubFactory(env.MY_DURABLE_OBJECT, 'getByName')(
 *   'room'
 * );
 * ```
 */
export function createRestorableStubFactory(
  namespace: unknown,
  method: string
): ((...args: unknown[]) => TransformStub<object>) | undefined {
  if (
    (typeof namespace !== 'object' && typeof namespace !== 'function') ||
    namespace === null
  ) {
    return undefined;
  }

  const get: unknown = Reflect.get(namespace, method);
  if (typeof get !== 'function') {
    return undefined;
  }

  return (...args) => {
    const reopen = () => Reflect.apply(get, namespace, args) as object;
    return createSourceStub({ stub: reopen(), broken: false, reopen }, []);
  };
}

// Service binding stubs answer any property with a callable RPC stub, so only
// an object exposing the DurableObjectId interface identifies a Durable Object.
function isDurableObjectId(value: unknown): value is DurableObjectId {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'equals') === 'function' &&
    typeof Reflect.get(value, 'toString') === 'function'
  );
}

function createSourceStub<TTarget extends object>(
  source: StubSource<TTarget>,
  transforms: ConfiguredCallerTransform[]
): TransformStub<TTarget> {
  return new Proxy(source.stub, {
    get(_target, property) {
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

          return createSourceStub(source, [
            ...transforms,
            (context) =>
              Promise.resolve(Reflect.apply(configured, undefined, [context])),
          ]);
        };
      }

      const accessedStub = currentStub(source);
      // Native bindings expose accessors that reject a Proxy receiver.
      const value: unknown = Reflect.get(accessedStub, property);
      if (typeof value !== 'function' || typeof property !== 'string') {
        return value;
      }

      // A concurrent call may already have replaced the broken stub.
      const markBroken = (stub: TTarget) => {
        if (source.stub === stub) {
          source.broken = true;
        }
      };

      // Observes failures without adopting the result, so pipelining survives.
      const callObserved = (
        method: (...args: unknown[]) => unknown,
        initialArgs: unknown[]
      ): unknown => {
        let result: unknown;
        try {
          result = Reflect.apply(method, accessedStub, initialArgs);
        } catch (error) {
          markBroken(accessedStub);
          throw error;
        }
        const then: unknown =
          (typeof result === 'object' || typeof result === 'function') &&
          result !== null
            ? Reflect.get(result, 'then')
            : undefined;
        if (typeof then === 'function') {
          Reflect.apply(then, result, [
            () => undefined,
            () => markBroken(accessedStub),
          ]);
        }
        return result;
      };

      const callWithTransforms = (initialArgs: unknown[]): Promise<unknown> => {
        const call = (
          stub: TTarget,
          context: TransformContext
        ): Promise<unknown> => {
          if (Object.keys(context).length === 0) {
            return Promise.resolve(
              Reflect.apply(
                (stub === accessedStub
                  ? value
                  : Reflect.get(stub, property)) as (
                  ...args: unknown[]
                ) => unknown,
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
        };

        const callRestorable = async (
          context: TransformContext
        ): Promise<unknown> => {
          const stub = currentStub(source);
          try {
            return await call(stub, context);
          } catch (error) {
            markBroken(stub);
            throw error;
          }
        };

        const id: unknown = Reflect.get(accessedStub, 'id');
        const actorId = isDurableObjectId(id) ? id : undefined;

        const run = (
          index: number,
          context: TransformContext
        ): Promise<unknown> => {
          const transform = transforms[index];
          if (!transform) {
            return source.reopen
              ? callRestorable(context)
              : call(source.stub, context);
          }

          return transform({
            method: property,
            args: initialArgs,
            actorId,
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

      return new Proxy(value, {
        // RPC properties are callable stubs; awaiting one must call its
        // native `then` with the stub itself as the receiver.
        get: (method, key) => {
          const member: unknown = Reflect.get(method, key);
          return typeof member === 'function' &&
            (key === 'then' || key === 'catch' || key === 'finally')
            ? member.bind(method)
            : member;
        },
        apply: (method, _thisArg, initialArgs: unknown[]) => {
          if (transforms.length > 0) {
            return pipelinedPromise(callWithTransforms(initialArgs));
          }
          if (source.reopen) {
            return callObserved(
              method as (...args: unknown[]) => unknown,
              initialArgs
            );
          }
          return Reflect.apply(method, accessedStub, initialArgs);
        },
      });
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
