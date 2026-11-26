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

// Keeps cache URLs well under common URL length limits.
const maxCacheUrlBytes = 4_096;

/** What a caller transform knows about a call. */
type CallerCall = {
  readonly method: string;
  readonly args: unknown[];
  /** The stub's Durable Object ID; a generic target cannot type it. */
  readonly actorId?: unknown;
};

/**
 * The cache URL of a call a caller transform sees, or `undefined` when its
 * arguments are not JSON or the URL would be too long to cache.
 */
export function callerCacheUrl(
  planVersion: number,
  call: CallerCall
): string | undefined {
  let url: string;

  try {
    url = cachedCallUrl({
      planVersion,
      instance:
        call.actorId === undefined
          ? nonDurableObjectInstance
          : String(call.actorId),
      method: call.method,
      args: call.args.map((arg, index) => toJson(arg, `args[${index}]`)),
    });
  } catch {
    return undefined;
  }

  return new TextEncoder().encode(url).byteLength > maxCacheUrlBytes
    ? undefined
    : url;
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
