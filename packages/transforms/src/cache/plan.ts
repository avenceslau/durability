import type { IsJson } from './json.js';

/** Ages of a cached result, measured from when the target returned it. */
export type CacheWindows = {
  /** Answered from the cache without calling the target. At least one second. */
  freshMs: number;
  /** Answered from the cache while one request refreshes it. At least `freshMs`. */
  staleMs: number;
};

/** Windows for each cache tier. A tier caches only the methods that have windows for it. */
export type MethodCachePolicy = {
  /** Windows for `memoryTier`, which is per isolate. */
  memory?: CacheWindows;
  /** Windows for the Workers cache, which is shared by every caller in a location. */
  location?: CacheWindows;
  /** Windows for `durableTier`, which is per calling Durable Object and survives its eviction. */
  durable?: CacheWindows;
  /** How long a cached result may still answer while refreshing it fails. Defaults to each tier's `staleMs`. */
  staleIfErrorMs?: number;
};

export type CacheTierName = 'memory' | 'durable' | 'location';

const tierNames: readonly CacheTierName[] = ['memory', 'durable', 'location'];

type PlatformMethod =
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

type CacheableResult<Result> = [Exclude<Result, undefined>] extends [never]
  ? false
  : IsJson<Exclude<Result, undefined>>;

/**
 * Async methods of `Target` whose arguments are JSON and whose result is JSON
 * or `undefined`. Methods that return nothing are not cacheable.
 */
export type CacheableMethod<Target> = {
  [Key in keyof Target & string]-?: Key extends PlatformMethod
    ? never
    : Target[Key] extends (...args: infer Args) => Promise<infer Result>
      ? IsJson<Exclude<Args[number], undefined>> extends true
        ? CacheableResult<Result> extends true
          ? Key
          : never
        : never
      : never;
}[keyof Target & string];

export type CachePlanOptions = {
  /** Part of every cache key. Bump it when a cached result changes shape. Defaults to 1. */
  version?: number;
  /**
   * Name of the entrypoint the Vite plugin generates for this plan, or `false`
   * to write it yourself. Defaults to the target's export name followed by `Reads`.
   */
  entrypoint?: string | false;
};

export type CachePlan<Target, Methods extends string = string> = {
  readonly version: number;
  readonly methods: Readonly<Record<Methods, MethodCachePolicy>>;
  /** Carries the target type; always `undefined` at runtime. */
  readonly target?: Target;
};

const millisecondsPerSecond = 1_000;
const minimumFreshMs = millisecondsPerSecond;

function checkWindow(
  method: string,
  name: string,
  ms: number,
  minimum: number
): void {
  if (!Number.isFinite(ms) || ms < minimum) {
    throw new RangeError(
      `Cache window ${name} of ${method} must be a finite number of at least ${minimum}ms`
    );
  }
}

/**
 * Declares which methods of `Target` are cached and for how long. Share the
 * plan between the Worker that owns `Target` and every caller.
 *
 * @example
 * ```ts
 * export const accountCache = cachePlan<Account>()({
 *   getMetadata: {
 *     memory: { freshMs: 5_000, staleMs: 60_000 },
 *     location: { freshMs: 60_000, staleMs: 86_400_000 },
 *   },
 * });
 * ```
 */
export function cachePlan<Target extends object>(
  options: CachePlanOptions = {}
): <const Methods extends CacheableMethod<Target>>(methods: {
  [Method in Methods]: MethodCachePolicy;
}) => CachePlan<Target, Methods> {
  const version = options.version ?? 1;

  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError('Cache plan version must be a positive safe integer');
  }

  return (methods) => {
    for (const [method, policy] of Object.entries<MethodCachePolicy>(methods)) {
      for (const tierName of tierNames) {
        const windows = policy[tierName];

        if (windows === undefined) {
          continue;
        }

        checkWindow(
          method,
          `${tierName}.freshMs`,
          windows.freshMs,
          minimumFreshMs
        );
        checkWindow(
          method,
          `${tierName}.staleMs`,
          windows.staleMs,
          windows.freshMs
        );
      }

      checkWindow(method, 'staleIfErrorMs', policy.staleIfErrorMs ?? 0, 0);
    }

    return { version, methods };
  };
}

export function methodPolicy<Target>(
  plan: CachePlan<Target>,
  method: string
): MethodCachePolicy | undefined {
  return Object.prototype.hasOwnProperty.call(plan.methods, method)
    ? plan.methods[method]
    : undefined;
}

const toSeconds = (ms: number): number =>
  Math.floor(ms / millisecondsPerSecond);

export function cacheControl(
  location: CacheWindows,
  staleIfErrorMs: number | undefined
): string {
  const { freshMs, staleMs } = location;

  return [
    'public',
    `max-age=${toSeconds(freshMs)}`,
    `stale-while-revalidate=${toSeconds(staleMs - freshMs)}`,
    `stale-if-error=${toSeconds(staleIfErrorMs ?? staleMs)}`,
  ].join(', ');
}
