import { isNumber, isObject } from '../predicates.js';
import { toJson, type Json } from './json.js';

/**
 * A result passed between cache tiers with the time the target returned it, so
 * each tier judges the age of what the tiers behind it answered with. The
 * transform stub unwraps it before the caller sees the result.
 */
export class CacheEntry {
  constructor(
    readonly value: Json | undefined,
    readonly loadedAt: number
  ) {}
}

/** A result from the tiers behind a tier: an entry they answered with, or a fresh result from the target. */
export function toCacheEntry(result: unknown): CacheEntry {
  if (result instanceof CacheEntry) {
    return result;
  }

  return new CacheEntry(
    result === undefined ? undefined : toJson(result, 'result'),
    Date.now()
  );
}

export function unwrapCacheEntry(result: unknown): unknown {
  return result instanceof CacheEntry ? result.value : result;
}

export function cloneCacheEntry(entry: CacheEntry): CacheEntry {
  return new CacheEntry(structuredClone(entry.value), entry.loadedAt);
}

export function encodeCacheEntry(entry: CacheEntry): string {
  return JSON.stringify(
    entry.value === undefined
      ? { loadedAt: entry.loadedAt }
      : { value: entry.value, loadedAt: entry.loadedAt }
  );
}

export function decodeCacheEntry(text: string): CacheEntry {
  const parsed: unknown = JSON.parse(text);

  if (!isObject(parsed) || Array.isArray(parsed)) {
    throw new TypeError('Cached entry is not a JSON object');
  }

  const fields: { value?: unknown; loadedAt?: unknown } = parsed;

  if (!isNumber(fields.loadedAt) || !Number.isFinite(fields.loadedAt)) {
    throw new TypeError('Cached entry has no load time');
  }

  return new CacheEntry(
    Object.prototype.hasOwnProperty.call(parsed, 'value')
      ? toJson(fields.value, 'result')
      : undefined,
    fields.loadedAt
  );
}
