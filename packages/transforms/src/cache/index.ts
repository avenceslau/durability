/**
 * Caches RPC results in tiers composed as caller transforms: per isolate with
 * {@link memoryTier}, per calling Durable Object with {@link durableTier}, and
 * in the Workers cache, shared by every caller in a location, with
 * {@link workerCacheTier} and {@link serveCached}. Declare what to cache with
 * {@link cachePlan}.
 *
 * @packageDocumentation
 */
export type { CachedCall } from './call.js';

export type { IsJson, Json } from './json.js';

export { durableTier } from './durable-tier.js';

export { memoryTier, type MemoryTierOptions } from './memory-tier.js';

export {
  cachePlan,
  type CacheableMethod,
  type CacheTierName,
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
