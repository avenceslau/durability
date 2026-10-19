import { DurableObject } from 'cloudflare:workers';
import {
  Durability,
  DurabilityAlarms,
  DurabilityScheduler,
  type DurableCall,
} from 'durability';
import { exponential } from 'durability/utils';

type Env = {
  SMOKE: DurableObjectNamespace<SmokeObject>;
};

// Exercises the shipped tarball exactly as an npm consumer would: a SQLite DO
// whose schema is migrated on first construction, with durable operations and a
// named alarm sharing one physical alarm through a scheduler.
export class SmokeObject extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });

  private readonly durability = new Durability({
    scheduler: this.scheduler,
    handlers: {
      succeed: async ({ payload }: DurableCall<{ value: number }>) =>
        payload.value * 2,
      flaky: async ({ attempt }: DurableCall<null>) => {
        const seen = (await this.ctx.storage.get<number[]>('flaky')) ?? [];
        await this.ctx.storage.put('flaky', [...seen, attempt]);
        if (attempt === 1) {
          throw new Error('transient');
        }
        return attempt;
      },
    },
    methods: {
      flaky: {
        retries: {
          delay: (attempt) => exponential(attempt, 1, 5),
          maxAttempts: 3,
        },
      },
    },
  });

  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: {
      ping: async ({ idempotencyKey }) => {
        await this.ctx.storage.put('ping', idempotencyKey);
      },
    },
  });

  runSucceed(value: number) {
    return this.durability.succeed({
      id: `succeed:${value}`,
      payload: { value },
    });
  }

  succeedResult(value: number) {
    return this.durability.succeed.getResult(`succeed:${value}`);
  }

  runFlaky() {
    return this.durability.flaky({ id: 'flaky', payload: null });
  }

  flakyResult() {
    return this.durability.flaky.getResult('flaky');
  }

  flakyAttempts() {
    return this.ctx.storage.get<number[]>('flaky');
  }

  schedulePing(at: number) {
    return this.alarms.ping(at);
  }

  pingKey() {
    return this.ctx.storage.get<string>('ping');
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export default {
  async fetch() {
    return new Response('ok');
  },
};
