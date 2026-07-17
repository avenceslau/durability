import { DurableObject } from 'cloudflare:workers';
import { createDurability } from '../src';

export type RecordedAlarm = {
  attempt: number;
  idempotencyKey: string;
  scheduledTime: number;
};

export class NamedAlarmTestObject extends DurableObject {
  private readonly durability = createDurability(
    this.ctx,
    {},
    {
      alarms: {
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
      alarmMethods: {
        cleanup: { retries: { delay: () => 50, maxAttempts: 2 } },
      },
    }
  );

  scheduleCleanup(scheduledTime: number) {
    return this.durability.alarm.cleanup(scheduledTime);
  }

  getRecorded() {
    return this.ctx.storage.get<RecordedAlarm[]>('recorded');
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }
}

export default {
  fetch() {
    return new Response('Not found', { status: 404 });
  },
};
