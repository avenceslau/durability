/**
 * Front Worker for the `job-dashboard` example. Browsers upgrade to the
 * tenant's `Dashboard`. A plain HTTP import talks to the `Pipeline` directly:
 * register, then wait on the handle in the same pipelined round trip.
 */
import type { Env } from './shared';

export { Dashboard } from './dashboard';
export { Pipeline } from './pipeline';

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const match = /^\/tenants\/([^/]+)\/(ws|imports)$/.exec(url.pathname);
    if (!match?.[1]) {
      return new Response('Not found', { status: 404 });
    }
    const [, tenant, action] = match;

    if (action === 'ws') {
      return env.DASHBOARD.getByName(tenant).fetch(request);
    }
    const orderId = url.searchParams.get('order');
    if (request.method !== 'POST' || !orderId) {
      return new Response('Expected POST ?order=<id>', { status: 400 });
    }
    const pipeline = env.PIPELINE.getByName(tenant);
    await pipeline.importOrder(orderId);
    const outcome = await pipeline.track(orderId).wait({ timeoutMs: 10_000 });
    return Response.json(outcome, {
      status: outcome.status === 'pending' ? 202 : 200,
    });
  },
};
