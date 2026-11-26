import { isFunction } from '../predicates.js';
import {
  nonDurableObjectInstance,
  parseCachedCall,
  type CachedCall,
} from './call.js';
import { encodeCacheEntry, toCacheEntry, type CacheEntry } from './entry.js';
import { cacheControl, methodPolicy, type CachePlan } from './plan.js';
import type { StorageTier } from './storage-tier.js';

type ServeCachedReporting<Target extends object> = {
  /** Called when the target throws; the response is `503` either way and is not cached. */
  onError?: (error: unknown, call: CachedCall) => void;
  /**
   * Tiers to read, in order, before calling the target, such as `kvTier`.
   * The response's `Cache-Control` counts the age of the entry they answer with.
   */
  tiers?: readonly StorageTier<Target>[];
};

/** A Durable Object namespace binding, with or without the Vite plugin's transform stubs. */
type DurableObjectNamespaceBinding = {
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): object;
};

export type ServeCachedOptions<Target extends object> =
  ServeCachedReporting<Target> &
    ({ namespace: DurableObjectNamespaceBinding } | { target: Target });

const notCached = (status: number): Response =>
  new Response(null, {
    status,
    headers: { 'cache-control': 'no-store' },
  });

function callThroughTiers<Target extends object>(
  tiers: readonly StorageTier<Target>[],
  call: CachedCall,
  callTarget: () => Promise<unknown>
): Promise<unknown> {
  const run = (index: number): Promise<unknown> => {
    const tier = tiers[index];

    if (tier === undefined) {
      return callTarget();
    }

    return tier.readThrough({
      method: call.method,
      args: call.args,
      // The tiers key Durable Object calls by the ID a stub would give them.
      actorId:
        call.instance === nonDurableObjectInstance ? undefined : call.instance,
      next: () => run(index + 1),
    });
  };

  return run(0);
}

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

  // RPC stubs answer every property, `apply` included, with a remote member.
  const callTarget = async (): Promise<unknown> =>
    Function.prototype.apply.call(method, target, call.args);

  let entry: CacheEntry;

  try {
    entry = toCacheEntry(
      await callThroughTiers(options.tiers ?? [], call, callTarget)
    );
  } catch (error) {
    options.onError?.(error, call);

    return notCached(503);
  }

  const ageMs = Date.now() - entry.loadedAt;

  return new Response(encodeCacheEntry(entry), {
    headers: {
      'cache-control': cacheControl(
        policy.location,
        policy.staleIfErrorMs,
        ageMs
      ),
      'content-type': 'application/json',
    },
  });
}
