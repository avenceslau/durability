import { DurableObject } from 'cloudflare:workers';
import {
  Durability,
  DurabilityAlarms,
  DurabilityScheduler,
  type DurableCall,
} from '../src';
export { DeliveryObject, FanoutConsumer } from './fanout-worker';

export type RecordedAlarm = {
  attempt: number;
  idempotencyKey: string;
  scheduledTime: number;
};

export class NamedAlarmTestObject extends DurableObject {
  private releaseTimeoutAttempt: (() => void) | undefined;
  private releaseBoundedHandlers: (() => void) | undefined;
  private readonly boundedGate = new Promise<void>((resolve) => {
    this.releaseBoundedHandlers = resolve;
  });
  private releaseOldReuse: (() => void) | undefined;
  private boundedActive = 0;
  private boundedMax = 0;
  private boundedCompleted = 0;
  private reuseInvocations = 0;

  private readonly scheduler = new DurabilityScheduler({
    context: this.ctx,
    alarmConcurrency: 2,
    alarmHandoffMs: 10,
  });

  private readonly durability = new Durability({
    scheduler: this.scheduler,
    handlers: {
      crash: async ({ attempt }: DurableCall<null>) => {
        const attempts =
          (await this.ctx.storage.get<number[]>('crash-attempts')) ?? [];
        await this.ctx.storage.put('crash-attempts', [...attempts, attempt]);
        await new Promise(() => undefined);
      },
      timeout: async ({ attempt }: DurableCall<null>) => {
        const attempts =
          (await this.ctx.storage.get<number[]>('timeout-attempts')) ?? [];
        await this.ctx.storage.put('timeout-attempts', [...attempts, attempt]);
        if (attempt === 1) {
          await new Promise<void>((resolve) => {
            this.releaseTimeoutAttempt = resolve;
          });
        }
      },
      terminalTimeout: async ({ attempt, signal }: DurableCall<null>) => {
        const attempts =
          (await this.ctx.storage.get<number[]>('terminal-timeout-attempts')) ??
          [];
        await this.ctx.storage.put('terminal-timeout-attempts', [
          ...attempts,
          attempt,
        ]);
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
      bounded: async (_call: DurableCall<null>) => {
        this.boundedActive += 1;
        this.boundedMax = Math.max(this.boundedMax, this.boundedActive);
        await this.boundedGate;
        this.boundedActive -= 1;
        this.boundedCompleted += 1;
      },
      reuse: async (_call: DurableCall<null>) => {
        this.reuseInvocations += 1;
        if (this.reuseInvocations === 1) {
          await new Promise<void>((resolve) => {
            this.releaseOldReuse = resolve;
          });
          return 'old';
        }
        return 'new';
      },
    },
    methods: {
      crash: {
        attemptTimeoutMs: 50,
        retries: { delay: () => 0, maxAttempts: 2 },
      },
      timeout: {
        attemptTimeoutMs: 50,
        retries: { delay: () => 0, maxAttempts: 2 },
      },
      terminalTimeout: {
        attemptTimeoutMs: 50,
        retries: { delay: () => 0, maxAttempts: 3 },
      },
    },
  });

  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: {
      cleanup: async ({ attempt, idempotencyKey, scheduledTime }) => {
        const recorded =
          (await this.ctx.storage.get<RecordedAlarm[]>('recorded')) ?? [];
        await this.ctx.storage.put('recorded', [
          ...recorded,
          { attempt, idempotencyKey, scheduledTime },
        ]);
        if (attempt === 1) {
          throw new Error('retry cleanup');
        }
      },
    },
    methods: { cleanup: { retries: { delay: () => 50, maxAttempts: 2 } } },
  });

  scheduleCleanup(scheduledTime: number) {
    return this.alarms.cleanup(scheduledTime);
  }

  getRecorded() {
    return this.ctx.storage.get<RecordedAlarm[]>('recorded');
  }

  startCrash() {
    return this.durability.crash({ id: 'crash', payload: null });
  }

  getCrashAttempts() {
    return this.ctx.storage.get<number[]>('crash-attempts');
  }

  getCrashResult() {
    return this.durability.crash.getResult('crash');
  }

  async resetCrash() {
    this.ctx.storage.sql.exec(
      `UPDATE durability_calls
       SET status = 'pending', next_attempt_at = 0
       WHERE id = 'crash'`
    );
    await this.ctx.storage.setAlarm(Date.now() + 5);
  }

  startTimeout() {
    return this.durability.timeout({ id: 'timeout', payload: null });
  }

  getTimeoutAttempts() {
    return this.ctx.storage.get<number[]>('timeout-attempts');
  }

  releaseTimeout() {
    this.releaseTimeoutAttempt?.();
  }

  startTerminalTimeout() {
    return this.durability.terminalTimeout({
      id: 'terminal-timeout',
      payload: null,
    });
  }

  getTerminalTimeoutAttempts() {
    return this.ctx.storage.get<number[]>('terminal-timeout-attempts');
  }

  getTerminalTimeoutResult() {
    return this.durability.terminalTimeout.getResult('terminal-timeout');
  }

  startBounded(count: number) {
    return Promise.all(
      Array.from({ length: count }, (_, index) =>
        this.durability.bounded({ id: `bounded:${index}`, payload: null })
      )
    ).then(() => undefined);
  }

  getBoundedState() {
    return { max: this.boundedMax, completed: this.boundedCompleted };
  }

  releaseBounded() {
    this.releaseBoundedHandlers?.();
  }

  startReuse() {
    return this.durability.reuse({ id: 'reuse', payload: null });
  }

  purgeAll() {
    return this.durability.purgeBefore(Number.MAX_SAFE_INTEGER);
  }

  releaseReuse() {
    this.releaseOldReuse?.();
  }

  getReuseResult() {
    return this.durability.reuse.getResult('reuse');
  }

  armNow() {
    return this.ctx.storage.setAlarm(Date.now() + 5);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export class KvAlarmTestObject extends DurableObject {
  private readonly scheduler = new DurabilityScheduler({
    context: this.ctx,
    storageBackend: 'kv',
  });

  private readonly durability = new Durability({
    scheduler: this.scheduler,
    handlers: {
      work: async ({ attempt }: DurableCall<null>) => {
        const attempts =
          (await this.ctx.storage.get<number[]>('kv-work-attempts')) ?? [];
        await this.ctx.storage.put('kv-work-attempts', [...attempts, attempt]);
        if (attempt === 1) {
          throw new Error('retry work');
        }
        return 'done';
      },
    },
    retries: { delay: () => 5, maxAttempts: 2 },
  });

  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: {
      cleanup: async ({ attempt, idempotencyKey, scheduledTime }) => {
        const recorded =
          (await this.ctx.storage.get<RecordedAlarm[]>('kv-recorded')) ?? [];
        await this.ctx.storage.put('kv-recorded', [
          ...recorded,
          { attempt, idempotencyKey, scheduledTime },
        ]);
      },
    },
  });

  startWork() {
    return this.durability.work({ id: 'work', payload: null });
  }

  getWorkAttempts() {
    return this.ctx.storage.get<number[]>('kv-work-attempts');
  }

  getWorkResult() {
    return this.durability.work.getResult('work');
  }

  scheduleCleanup(scheduledTime: number) {
    return this.alarms.cleanup(scheduledTime);
  }

  getRecorded() {
    return this.ctx.storage.get<RecordedAlarm[]>('kv-recorded');
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export default {
  fetch() {
    return new Response('Not found', { status: 404 });
  },
};
