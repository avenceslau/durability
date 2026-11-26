/**
 * Caches RPC results in the Workers cache, shared by every caller in a
 * location. Declare what to cache with {@link cachePlan}, answer cached calls
 * with {@link serveCached}, and route calls through the cache with the
 * {@link workerCacheTier} caller transform.
 *
 * @packageDocumentation
 */
export type { CachedCall } from './call.js';

export type { IsJson, Json } from './json.js';

export {
  cachePlan,
  type CacheableMethod,
  type CachePlan,
  type CachePlanOptions,
  type CacheWindows,
  type MethodCachePolicy,
} from './plan.js';

export { serveCached, type ServeCachedOptions } from './serve.js';

export {
  CachedCallError,
  workerCacheTier,
  type WorkerCacheCallOptions,
  type WorkerCacheRead,
  type WorkerCacheTierOptions,
} from './worker-cache-tier.js';
