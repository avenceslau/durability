import { hashedCacheKey } from './call.js';
import { CacheEntry } from './entry.js';
import type { Json } from './json.js';
import type { CachePlan } from './plan.js';
import { storageTier, type CacheStore } from './storage-tier.js';

type StoredEntry = {
  value?: Json;
  loadedAt: number;
  expiresAt: number;
};

/**
 * Caller transform that caches the plan's `durable` methods in the storage of
 * the Durable Object that makes the calls, so its cached results survive
 * eviction. Create one per object, in its constructor. Expired entries are
 * deleted when read; entries for calls that are never made again stay in
 * storage.
 *
 * @example
 * ```ts
 * export class Invoice extends DurableObject<Env> {
 *   readonly #accountDurable = durableTier(accountCache, this.ctx.storage);
 *
 *   getAccount(accountId: number) {
 *     return this.env.ACCOUNTS.getByName(String(accountId))
 *       .with(this.#accountDurable)
 *       .with(accountReads)
 *       .getMetadata(accountId);
 *   }
 * }
 * ```
 */
export function durableTier<Target extends object, Methods extends string>(
  plan: CachePlan<Target, Methods>,
  storage: DurableObjectStorage
) {
  const store: CacheStore = {
    async get(key) {
      const stored = await storage.get<StoredEntry>(key);

      if (stored === undefined) {
        return undefined;
      }

      if (stored.expiresAt <= Date.now()) {
        await storage.delete(key);

        return undefined;
      }

      return new CacheEntry(stored.value, stored.loadedAt);
    },
    async set(key, entry, keepForMs) {
      const stored: StoredEntry = {
        loadedAt: entry.loadedAt,
        expiresAt: entry.loadedAt + keepForMs,
      };

      await storage.put(
        key,
        entry.value === undefined ? stored : { ...stored, value: entry.value }
      );
    },
  };

  return storageTier(plan, 'durable', store, hashedCacheKey);
}
