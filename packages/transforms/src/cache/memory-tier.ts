import { cloneCacheEntry, type CacheEntry } from './entry.js';
import type { CachePlan } from './plan.js';
import { storageTier, type CacheStore } from './storage-tier.js';

export type MemoryTierOptions = {
  /** Most entries kept; the least recently used are evicted first. Defaults to 1000. */
  maxEntries?: number;
};

type MemoryEntry = {
  entry: CacheEntry;
  expiresAt: number;
};

/**
 * Caller transform that caches the plan's `memory` methods in this isolate.
 * Create it once at module scope so its entries and in-flight loads outlive a
 * request. Values are cloned in and out, so callers cannot change a cached
 * result.
 *
 * @example
 * ```ts
 * const accountMemory = memoryTier(accountCache, { maxEntries: 10_000 });
 *
 * await env.ACCOUNTS.getByName(id)
 *   .with(accountMemory)
 *   .with(accountReads)
 *   .getMetadata(accountId);
 * ```
 */
export function memoryTier<Target extends object, Methods extends string>(
  plan: CachePlan<Target, Methods>,
  options: MemoryTierOptions = {}
) {
  const maxEntries = options.maxEntries ?? 1_000;

  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('maxEntries must be a positive safe integer');
  }

  // Map keeps insertion order, so re-inserting on use puts the least recently
  // used entry first.
  const entries = new Map<string, MemoryEntry>();

  const store: CacheStore = {
    async get(key) {
      const stored = entries.get(key);

      if (stored === undefined) {
        return undefined;
      }

      entries.delete(key);

      if (stored.expiresAt <= Date.now()) {
        return undefined;
      }

      entries.set(key, stored);

      return cloneCacheEntry(stored.entry);
    },
    async set(key, entry, keepForMs) {
      entries.delete(key);
      entries.set(key, {
        entry: cloneCacheEntry(entry),
        expiresAt: entry.loadedAt + keepForMs,
      });

      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) {
          break;
        }

        entries.delete(oldest);
      }
    },
  };

  return storageTier(plan, 'memory', store, (url) => url);
}
