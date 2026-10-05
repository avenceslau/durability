/**
 * `DurabilityAlarms` + `DurabilityScheduler` example: recurring named alarms
 * that trigger durable operations, sharing one physical Durable Object alarm.
 *
 * Each subscription object schedules a `renew` alarm. When it fires, the
 * handler registers a durable `chargeInvoice` operation (retried on failure
 * independently of the alarm) and schedules the next occurrence. Scheduling a
 * name again replaces its pending occurrence, so `subscribe` is repeatable.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  Durability,
  DurabilityAlarms,
  DurabilityScheduler,
  type DurableCall,
} from 'durability';

type Env = {
  SUBSCRIPTIONS: DurableObjectNamespace<Subscription>;
  PAYMENTS: Fetcher;
};

const renewalPeriodMs = 30 * 24 * 60 * 60 * 1000;

type ChargeInput = { customerId: string; periodStart: number };

export class Subscription extends DurableObject<Env> {
  // One object uses both helpers, so they must share a scheduler: it owns the
  // single physical alarm and one concurrency pool for all handlers.
  private readonly scheduler = new DurabilityScheduler({
    context: this.ctx,
    alarmConcurrency: 5,
  });

  private readonly durability = new Durability({
    scheduler: this.scheduler,
    handlers: {
      chargeInvoice: async ({ id, payload }: DurableCall<ChargeInput>) => {
        const response = await this.env.PAYMENTS.fetch(
          'https://payments/charge',
          {
            method: 'POST',
            headers: { 'Idempotency-Key': id },
            body: JSON.stringify(payload),
          }
        );
        if (!response.ok) {
          throw new Error(`Charge failed with ${response.status}`);
        }
      },
    },
    retries: { maxAttempts: 8 },
  });

  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: {
      renew: async ({ idempotencyKey, scheduledTime }) => {
        const customerId = await this.ctx.storage.get<string>('customerId');
        if (customerId === undefined) {
          return; // Cancelled; let this occurrence complete without renewing.
        }
        // The alarm's idempotencyKey is stable across its retries, so a
        // retried occurrence cannot double-charge.
        await this.durability.chargeInvoice({
          id: idempotencyKey,
          payload: { customerId, periodStart: scheduledTime },
        });
        await this.alarms.renew(scheduledTime + renewalPeriodMs);
      },
    },
  });

  async subscribe(customerId: string) {
    await this.ctx.storage.put('customerId', customerId);
    await this.alarms.renew(Date.now() + renewalPeriodMs);
  }

  async cancel() {
    await this.ctx.storage.delete('customerId');
  }

  /** Destructive retention cleanup for settled records older than 90 days. */
  async purgeHistory() {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    return {
      operations: await this.durability.purgeBefore(cutoff),
      alarms: await this.alarms.purgeBefore(cutoff),
    };
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const [, customerId, action] = url.pathname.split('/');
    if (!customerId || request.method !== 'POST') {
      return new Response('Expected POST /:customerId/(subscribe|cancel)', {
        status: 404,
      });
    }
    const subscription = env.SUBSCRIPTIONS.getByName(customerId);

    if (action === 'subscribe') {
      await subscription.subscribe(customerId);
      return new Response('subscribed', { status: 201 });
    }
    if (action === 'cancel') {
      await subscription.cancel();
      return new Response('cancelled');
    }
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
