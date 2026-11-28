import { isFunction } from '../predicates.js';
import {
  nonDurableObjectInstance,
  parseCachedCall,
  type CachedCall,
} from './call.js';
import { encodeCacheEntry, toCacheEntry } from './entry.js';
import { cacheControl, methodPolicy, type CachePlan } from './plan.js';

type ServeCachedReporting = {
  /** Called when the target throws; the response is `503` either way and is not cached. */
  onError?: (error: unknown, call: CachedCall) => void;
};

/** A Durable Object namespace binding, with or without the Vite plugin's transform stubs. */
type DurableObjectNamespaceBinding = {
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): object;
};

export type ServeCachedOptions<Target> = ServeCachedReporting &
  ({ namespace: DurableObjectNamespaceBinding } | { target: Target });

const notCached = (status: number): Response =>
  new Response(null, {
    status,
    headers: { 'cache-control': 'no-store' },
  });

function resolveTarget<Target extends object>(
  options: ServeCachedOptions<Target>,
  instance: string
): object | undefined {
  if ('target' in options) {
    return instance === nonDurableObjectInstance ? options.target : undefined;
  }

  try {
    return options.namespace.get(options.namespace.idFromString(instance));
  } catch {
    return undefined;
  }
}

/**
 * Answers a request sent by `workerCacheTier`: calls the planned method on the
 * target and returns its result with a `Cache-Control` header built from the
 * plan. Call it from the `fetch` handler of an entrypoint that has the Workers
 * cache enabled. The Vite plugin can generate that entrypoint.
 *
 * Requests for methods outside the plan, malformed requests, and calls that
 * throw are answered with `no-store`, so the cache never keeps them.
 *
 * @example
 * ```ts
 * export class AccountReads extends WorkerEntrypoint<Env> {
 *   fetch(request: Request) {
 *     return serveCached(request, accountCache, {
 *       namespace: this.env.ACCOUNTS,
 *     });
 *   }
 * }
 * ```
 */
export async function serveCached<
  Target extends object,
  Methods extends string,
>(
  request: Request,
  plan: CachePlan<Target, Methods>,
  options: ServeCachedOptions<Target>
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return notCached(405);
  }

  const call = parseCachedCall(request.url);

  if (call === undefined || call.planVersion !== plan.version) {
    return notCached(400);
  }

  const policy = methodPolicy(plan, call.method);

  if (policy?.location === undefined) {
    return notCached(404);
  }

  const target = resolveTarget(options, call.instance);

  if (target === undefined) {
    return notCached(400);
  }

  // SAFETY: only reads one property, and the value is checked before use.
  const method = (target as Record<string, unknown>)[call.method];

  if (!isFunction(method)) {
    return notCached(404);
  }

  let body: string;

  try {
    // RPC stubs answer every property, `apply` included, with a remote member.
    const methodResult: unknown = await Function.prototype.apply.call(
      method,
      target,
      call.args
    );

    body = encodeCacheEntry(toCacheEntry(methodResult));
  } catch (error) {
    options.onError?.(error, call);

    return notCached(503);
  }

  return new Response(body, {
    headers: {
      'cache-control': cacheControl(policy.location, policy.staleIfErrorMs),
      'content-type': 'application/json',
    },
  });
}
