import { waitUntil } from 'cloudflare:workers';
import { defineTransform } from '../define.js';
import { callerCacheUrl, type CallerCall } from './call.js';
import { cloneCacheEntry, toCacheEntry, type CacheEntry } from './entry.js';
import { methodPolicy, type CachePlan, type CacheTierName } from './plan.js';

/** Where a storage tier keeps entries. */
export type CacheStore = {
  get(key: string): Promise<CacheEntry | undefined>;
  /** Keeps `entry` for at least `keepForMs` after it was loaded. */
  set(key: string, entry: CacheEntry, keepForMs: number): Promise<void>;
};

/** A call as a storage tier reads it, from a caller transform or from `serveCached`. */
export type StorageTierCall = CallerCall & {
  next(): Promise<unknown>;
};

/** A tier built on {@link storageTier}, such as `memoryTier` or `kvTier`. */
export type StorageTier<Target extends object> = ReturnType<
  typeof storageTier<Target, string>
>;

/**
 * A caller transform that answers planned methods from `store` while their
 * entries are within the plan's windows for `tierName`, and otherwise loads
 * them from the tiers behind it, one load per key at a time.
 */
export function storageTier<Target extends object, Methods extends string>(
  plan: CachePlan<Target, Methods>,
  tierName: CacheTierName,
  store: CacheStore,
  storeKey: (url: string) => string | Promise<string>
) {
  const loads = new Map<string, Promise<CacheEntry>>();

  const load = (
    key: string,
    keepForMs: number,
    next: () => Promise<unknown>
  ): Promise<CacheEntry> => {
    const running = loads.get(key);

    if (running !== undefined) {
      return running.then(cloneCacheEntry);
    }

    const started = next()
      .then(toCacheEntry)
      .then(async (entry) => {
        // A tier that cannot store an entry still answers with it.
        await store.set(key, entry, keepForMs).catch(() => undefined);

        return entry;
      })
      .finally(() => loads.delete(key));

    loads.set(key, started);

    return started;
  };

  const readThrough = async (context: StorageTierCall): Promise<unknown> => {
    const { method, next } = context;
    const policy = methodPolicy(plan, method);
    const windows = policy?.[tierName];

    const url =
      windows === undefined ? undefined : callerCacheUrl(plan.version, context);

    if (policy === undefined || windows === undefined || url === undefined) {
      return next();
    }

    const key = await storeKey(url);
    const staleIfErrorMs = policy.staleIfErrorMs ?? windows.staleMs;
    const keepForMs = Math.max(windows.staleMs, staleIfErrorMs);
    const stored = await store.get(key).catch(() => undefined);

    const ageMs =
      stored === undefined
        ? Number.POSITIVE_INFINITY
        : Date.now() - stored.loadedAt;

    if (stored !== undefined && ageMs < windows.freshMs) {
      return stored;
    }

    if (stored !== undefined && ageMs < windows.staleMs) {
      // A failed refresh keeps the stale entry, and a later call retries it.
      waitUntil(load(key, keepForMs, next).catch(() => undefined));

      return stored;
    }

    try {
      return await load(key, keepForMs, next);
    } catch (error) {
      if (stored !== undefined && ageMs < staleIfErrorMs) {
        return stored;
      }

      throw error;
    }
  };

  return {
    ...defineTransform<Target>().caller(() => readThrough),
    /** Reads a call through this tier outside a transform stub, as `serveCached` does. */
    readThrough,
  };
}
