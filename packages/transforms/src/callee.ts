import { RpcTarget } from 'cloudflare:workers';
import {
  reservedRpcMethods,
  type AsyncMethodKey,
  type RegisteredTransform,
  type RuntimeTransformContext,
  type TransformContext,
  type TransformContextOf,
  type TransformTargetOf,
} from './define.js';

const platformPrototypeNames = new Set([
  'DurableObject',
  'Object',
  'RpcTarget',
  'WorkerEntrypoint',
]);

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
          : TransformContextOf<TTransform> extends DOTransformContext<TTarget>
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
  const explicitMethods = new Set(Object.keys(config.methods ?? {}));
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
    const seenMethods = new Set<string>();
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
        if (seenMethods.has(method)) {
          continue;
        }
        seenMethods.add(method);
        if (reservedRpcMethods.has(method)) {
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
          (!explicitMethods.has(method) &&
            !inheritedOriginal &&
            candidate.constructor.name !== 'AsyncFunction')
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
