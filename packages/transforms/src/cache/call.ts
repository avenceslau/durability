import { canonicalJson, toJson, type Json } from './json.js';

// The Workers cache keys entries by URL, so the host only has to be stable.
const cacheOrigin = 'https://cache.invalid';
const protocolVersion = 'v1';

/** Instance segment for targets that are not Durable Objects. */
export const noInstance = '_';

/** One method call, as {@link workerCacheTier} sends it and {@link serveCached} answers it. */
export type CachedCall = {
  planVersion: number;
  /** Durable Object ID, or {@link noInstance}. */
  instance: string;
  method: string;
  args: Json[];
};

/** The cache URL of `call`. Arguments are encoded with sorted keys, so key order does not split entries. */
export function cachedCallUrl(call: CachedCall): string {
  const path = [
    protocolVersion,
    String(call.planVersion),
    call.instance,
    call.method,
  ]
    .map(encodeURIComponent)
    .join('/');

  return `${cacheOrigin}/${path}?args=${encodeURIComponent(canonicalJson(call.args))}`;
}

/** Reads a URL built by {@link cachedCallUrl}, or returns `undefined` for any other URL. */
export function parseCachedCall(url: string): CachedCall | undefined {
  try {
    const parsed = new URL(url);

    const [version, planVersion, instance, method, ...rest] = parsed.pathname
      .slice(1)
      .split('/')
      .map(decodeURIComponent);

    const encodedArgs = parsed.searchParams.get('args');

    if (
      version !== protocolVersion ||
      rest.length > 0 ||
      !instance ||
      !method ||
      encodedArgs === null
    ) {
      return undefined;
    }

    const args = toJson(JSON.parse(encodedArgs), 'args');

    if (!Array.isArray(args)) {
      return undefined;
    }

    return {
      planVersion: Number(planVersion),
      instance,
      method,
      args,
    };
  } catch {
    return undefined;
  }
}
