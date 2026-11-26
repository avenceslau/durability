import { defineTransform } from '../define.js';
import { cachedCallUrl, noInstance } from './call.js';
import { decodeResult, encodeResult, toJson, type Json } from './json.js';
import { methodPolicy, type CachePlan } from './plan.js';

// Keeps cache URLs well under common URL length limits.
const maxCacheUrlBytes = 4_096;

export type WorkerCacheRead = {
  method: string;
  /**
   * - `cache`: answered through the cache entrypoint.
   * - `direct`: not cacheable (method outside the plan, or arguments too large
   *   or not JSON), so the target was called directly.
   * - `fallback`: the cached request failed, so the target was called directly.
   * - `failed`: the cached request failed and `fallback` is `'throw'`.
   */
  outcome: 'cache' | 'direct' | 'fallback' | 'failed';
  /** The `CF-Cache-Status` response header, when present. */
  cacheStatus?: string;
  error?: unknown;
};

export type WorkerCacheTierOptions = {
  /** Service binding to the entrypoint that answers with {@link serveCached}. */
  binding: () => Fetcher;
  /** Calls the target directly (`'rpc'`, the default) or throws {@link CachedCallError} when a cached request fails. */
  fallback?: 'rpc' | 'throw';
  /** Called once for every call the transform handles. */
  onRead?: (read: WorkerCacheRead) => void;
};

/** Per-call options: `stub.with(tier, { cache: 'no-cache' })`. */
export type WorkerCacheCallOptions = {
  /**
   * Standard `RequestInit.cache` for the cached request: `'no-cache'`
   * refreshes the cached result before answering, and `'no-store'` skips the
   * cache for this call.
   */
  cache?: 'no-cache' | 'no-store';
};

export class CachedCallError extends Error {
  readonly method: string;
  /** HTTP status of the cached request, or `undefined` when the request itself failed. */
  readonly status: number | undefined;

  constructor(method: string, status: number | undefined) {
    super(
      status === undefined
        ? `Cached call to ${method} failed`
        : `Cached call to ${method} failed with status ${status}`
    );
    this.name = 'CachedCallError';
    this.method = method;
    this.status = status;
  }
}

function cacheUrl<Target>(
  plan: CachePlan<Target>,
  instance: string,
  method: string,
  args: unknown[]
): string | undefined {
  if (methodPolicy(plan, method) === undefined) {
    return undefined;
  }

  let url: string;

  try {
    url = cachedCallUrl({
      planVersion: plan.version,
      instance,
      method,
      args: args.map((arg, index) => toJson(arg, `args[${index}]`)),
    });
  } catch {
    return undefined;
  }

  return new TextEncoder().encode(url).byteLength > maxCacheUrlBytes
    ? undefined
    : url;
}

/**
 * Caller transform that answers the plan's methods through the Workers cache.
 * Each call becomes a `GET` to an entrypoint that answers with
 * {@link serveCached}, so every caller in a location shares one cached result
 * per Durable Object, method and arguments, and concurrent misses reach the
 * target once.
 *
 * Methods outside the plan are called directly. Results always come back as
 * JSON, whichever path answered.
 *
 * @example
 * ```ts
 * const accountReads = workerCacheTier(accountCache, {
 *   binding: () => env.ACCOUNT_READS,
 * });
 *
 * await env.ACCOUNTS.getByName(id).with(accountReads).getMetadata(accountId);
 * ```
 */
export function workerCacheTier<Target extends object, Methods extends string>(
  plan: CachePlan<Target, Methods>,
  options: WorkerCacheTierOptions
) {
  const fallback = options.fallback ?? 'rpc';

  return defineTransform<Target>().caller(
    (callOptions: WorkerCacheCallOptions | undefined) => async (context) => {
      const { method, args, next } = context;

      const report = (read: Omit<WorkerCacheRead, 'method'>) =>
        options.onRead?.({ method, ...read });

      // Caller transforms receive the Durable Object ID of the stub, and
      // `undefined` for other targets.
      const actorId = 'actorId' in context ? context.actorId : undefined;

      const url = cacheUrl(
        plan,
        actorId === undefined ? noInstance : String(actorId),
        method,
        args
      );

      if (url === undefined) {
        report({ outcome: 'direct' });

        return next();
      }

      let result: Json | undefined;
      let cacheStatus: string | null;

      try {
        const response =
          callOptions?.cache === undefined
            ? await options.binding().fetch(url)
            : await options.binding().fetch(url, { cache: callOptions.cache });

        if (!response.ok) {
          await response.body?.cancel();

          throw new CachedCallError(method, response.status);
        }

        result = decodeResult(await response.text());
        cacheStatus = response.headers.get('cf-cache-status');
      } catch (error) {
        if (fallback === 'throw') {
          report({ outcome: 'failed', error });

          throw error instanceof CachedCallError
            ? error
            : Object.assign(new CachedCallError(method, undefined), {
                cause: error,
              });
        }

        report({ outcome: 'fallback', error });

        return decodeResult(encodeResult(await next()));
      }

      report(
        cacheStatus === null
          ? { outcome: 'cache' }
          : { outcome: 'cache', cacheStatus }
      );

      return result;
    }
  );
}
