/**
 * Caches RPC results in tiers composed as caller transforms: per isolate with
 * {@link memoryTier}, in the Workers cache, shared by every caller in a
 * location, with {@link workerCacheTier} and {@link serveCached}, and in
 * Workers KV, shared by every location, with {@link kvTier}. Declare what to
 * cache with {@link cachePlan}.
 *
 * @packageDocumentation
 */
export type { CachedCall } from './call.js';

export type { IsJson, Json } from './json.js';

export { kvTier } from './kv-tier.js';

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

export type { StorageTier } from './storage-tier.js';

export {
  CachedCallError,
  workerCacheTier,
  type WorkerCacheCallOptions,
  type WorkerCacheRead,
  type WorkerCacheTierOptions,
} from './worker-cache-tier.js';
