import { defineTransform } from '../define.js';
import { cachedCallUrl, nonDurableObjectInstance } from './call.js';
import { decodeResult, encodeResult, toJson, type Json } from './json.js';
import { methodPolicy, type CachePlan } from './plan.js';

// Keeps cache URLs well under common URL length limits.
const maxCacheUrlBytes = 4_096;
const defaultTimeoutMs = 5_000;

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
  cfCacheStatus?: string;
  error?: unknown;
};

export type WorkerCacheTierOptions = {
  /** Service binding to the entrypoint that answers with `serveCached`. */
  binding: () => Fetcher;
  /** Calls the target directly (`'rpc'`, the default) or throws {@link CachedCallError} when a cached request fails. */
  fallback?: 'rpc' | 'throw';
  /** Aborts a cached request after this many milliseconds, then applies `fallback`. Defaults to 5000. */
  timeoutMs?: number;
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

type CachedResponse = {
  cachedResult: Json | undefined;
  cfCacheStatus: string | null;
};

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

async function fetchCachedResult(
  binding: Fetcher,
  url: string,
  method: string,
  init: RequestInit
): Promise<CachedResponse> {
  const response = await binding.fetch(url, init);

  if (!response.ok) {
    await response.body?.cancel();

    throw new CachedCallError(method, response.status);
  }

  return {
    cachedResult: decodeResult(await response.text()),
    cfCacheStatus: response.headers.get('cf-cache-status'),
  };
}

/**
 * Caller transform that answers the plan's methods through the Workers cache.
 * Each call becomes a `GET` to an entrypoint that answers with `serveCached`,
 * so every caller in a location shares one cached result per Durable Object,
 * method and arguments.
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
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

  return defineTransform<Target>().caller(
    (callOptions: WorkerCacheCallOptions | undefined) => async (context) => {
      const { method, args, next } = context;

      const report = (read: Omit<WorkerCacheRead, 'method'>) =>
        options.onRead?.({ method, ...read });

      // Caller transforms receive the Durable Object ID of the stub, and
      // `undefined` for other targets; a generic Target cannot type it.
      const actorId = 'actorId' in context ? context.actorId : undefined;

      const url = cacheUrl(
        plan,
        actorId === undefined ? nonDurableObjectInstance : String(actorId),
        method,
        args
      );

      if (url === undefined) {
        report({ outcome: 'direct' });

        return next();
      }

      const signal = AbortSignal.timeout(timeoutMs);

      let cached: CachedResponse;

      try {
        cached = await fetchCachedResult(
          options.binding(),
          url,
          method,
          callOptions?.cache === undefined
            ? { signal }
            : { signal, cache: callOptions.cache }
        );
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
        cached.cfCacheStatus === null
          ? { outcome: 'cache' }
          : { outcome: 'cache', cfCacheStatus: cached.cfCacheStatus }
      );

      return cached.cachedResult;
    }
  );
}
