import { canonicalJson, toJson, type Json } from './json.js';

// The Workers cache keys entries by URL, so the host only has to be stable.
const cacheOrigin = 'https://cache.invalid';
const protocolVersion = 'v1';

export const nonDurableObjectInstance = '_';

/** One cached method call, as `serveCached` passes it to `onError`. */
export type CachedCall = {
  planVersion: number;
  /** Durable Object ID, or `_` for targets that are not Durable Objects. */
  instance: string;
  method: string;
  args: Json[];
};

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
