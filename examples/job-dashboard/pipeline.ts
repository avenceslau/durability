/**
 * Producer side of the `job-dashboard` example. Runs durable operations, fans
 * their lifecycle out to the tenant's `Dashboard`, and hands out tracker
 * handles so callers can wait for a result over Workers RPC. Browsers never
 * connect here.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  Durability,
  DurabilityFanout,
  DurabilityScheduler,
  type DurableCall,
} from 'durability';
import { DurabilityTracker } from 'durability/experimental';
import type { Env, JobEvent, OrderSummary } from './shared';

export class Pipeline extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });

  private readonly durability = new Durability({
    scheduler: this.scheduler,
    handlers: {
      importOrder: async ({
        id,
        payload,
        signal,
      }: DurableCall<{ orderId: string }>): Promise<OrderSummary> => {
        const response = await this.env.ORDERS.fetch(
          `https://orders/${payload.orderId}`,
          { headers: { 'Idempotency-Key': id }, signal }
        );
        if (!response.ok) {
          throw new Error(`Order lookup failed with ${response.status}`);
        }
        return response.json();
      },
    },
    // Completed lifecycle events carry the summary the dashboard publishes.
    includeResults: true,
  });

  private readonly tracker = new DurabilityTracker({
    sources: { jobs: this.durability },
  });

  // Push side. Delivery is durable: the dashboard gets the batch again after
  // an eviction or a failed call, until `ingest` returns without throwing.
  private readonly fanout = new DurabilityFanout<JobEvent>({
    scheduler: this.scheduler,
    targets: {
      dashboard: {
        deliver: (messages) =>
          this.env.DASHBOARD.getByName(this.tenant).ingest(
            messages.map((message) => message.body)
          ),
        ackOnReturn: true,
      },
    },
    batchDelayMs: 100,
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Lifecycle hooks are best-effort. If the object dies between a job
    // settling and this enqueue committing, that one event is lost until the
    // dashboard resyncs. Enqueue from inside the handler, keyed by `id`, when
    // that gap matters.
    this.durability.lifecycle((event) => {
      if (event.type === 'registered') {
        return this.publish(event, { status: 'pending' });
      }
      if (
        event.type === 'attempt_settled' &&
        event.outcome === 'completed' &&
        event.result !== undefined
      ) {
        return this.publish(event, {
          status: 'completed',
          result: event.result,
        });
      }
      if (
        (event.type === 'attempt_settled' && event.outcome === 'failed') ||
        event.type === 'terminal'
      ) {
        return this.publish(event, { status: 'failed', error: event.error });
      }
      return undefined;
    });
  }

  private get tenant(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  private async publish(
    event: { id: string; generation: string; timestamp: number },
    state: JobEvent['state']
  ): Promise<void> {
    await this.fanout.enqueue([
      {
        id: `${event.id}:${event.generation}:${state.status}`,
        body: {
          id: event.id,
          name: 'importOrder',
          generation: event.generation,
          createdAt: event.timestamp,
          state,
        },
      },
    ]);
  }

  /** Registers the import; resolves on acceptance, not completion. */
  importOrder(orderId: string) {
    return this.durability.importOrder({
      id: `import:${orderId}`,
      payload: { orderId },
    });
  }

  /**
   * Pull side. Over Workers RPC the handle's `get` and `wait` become stubs, so
   * `stub.track(id).wait({ timeoutMs })` waits in one pipelined round trip.
   */
  async track(orderId: string) {
    const handle = await this.tracker.get('jobs', `import:${orderId}`);
    if (!handle) {
      throw new Error(`Order "${orderId}" was never imported`);
    }
    return handle;
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}
