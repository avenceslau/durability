import { decodeCacheEntry, encodeCacheEntry } from './entry.js';
import type { CachePlan } from './plan.js';
import { storageTier, type CacheStore } from './storage-tier.js';
import { waitUntil } from 'cloudflare:workers';

// KV rejects expirations sooner than 60 seconds.
const minimumExpirationSeconds = 60;
const keyPrefix = 'durability-cache:';

// KV keys are at most 512 bytes, and cache URLs can be longer.
async function hashedKey(url: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(url)
  );

  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');

  return `${keyPrefix}${hex}`;
}

/**
 * Caller transform that caches the plan's `global` methods in Workers KV,
 * shared by every location. KV reads can lag writes made in other locations,
 * so keep `global.freshMs` at a minute or more. Writes happen in the
 * background and never delay the call.
 *
 * Use it in front of the Durable Object, either in callers or in the cache
 * entrypoint through `serveCached`'s `tiers` option.
 *
 * @example
 * ```ts
 * const accountGlobal = kvTier(accountCache, () => env.ACCOUNT_CACHE);
 *
 * return serveCached(request, accountCache, {
 *   namespace: this.env.ACCOUNTS,
 *   tiers: [accountGlobal],
 * });
 * ```
 */
export function kvTier<Target extends object, Methods extends string>(
  plan: CachePlan<Target, Methods>,
  namespace: () => KVNamespace
) {
  const store: CacheStore = {
    async get(key) {
      const text = await namespace().get(key, 'text');

      return text === null ? undefined : decodeCacheEntry(text);
    },
    async set(key, entry, keepForMs) {
      const remainingSeconds = Math.ceil(
        (entry.loadedAt + keepForMs - Date.now()) / 1_000
      );

      waitUntil(
        namespace()
          .put(key, encodeCacheEntry(entry), {
            expirationTtl: Math.max(minimumExpirationSeconds, remainingSeconds),
          })
          // A failed write leaves the next miss to load and write again.
          .catch(() => undefined)
      );
    },
  };

  return storageTier(plan, 'global', store, hashedKey);
}
