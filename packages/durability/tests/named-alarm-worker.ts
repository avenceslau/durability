import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { createDurability, type DurableCall } from '../src';

export type RecordedAlarm = {
  attempt: number;
  idempotencyKey: string;
  scheduledTime: number;
};

export class NamedAlarmTestObject extends DurableObject {
  private releases: Array<() => void> = [];
  private ignoreReleases: Array<() => void> = [];
  private active = 0;
  private maxActive = 0;
  private ignoreActive = 0;
  private ignoreInvocations = 0;
  private ignoreMaxActive = 0;

  private readonly durability = createDurability(
    this.ctx,
    {
      recover: async ({ attempt, payload }: DurableCall<string>) => {
        const attempts =
          (await this.ctx.storage.get<number>('recover-attempts')) ?? 0;
        await this.ctx.storage.put('recover-attempts', attempts + 1);
        if (attempt === 1) {
          throw new Error('recover after eviction');
        }
        return payload;
      },
      crashAfterClaim: async ({ attempt }: DurableCall<undefined>) => {
        const invocations =
          (await this.ctx.storage.get<number>('crash-invocations')) ?? 0;
        await this.ctx.storage.put('crash-invocations', invocations + 1);
        if (attempt === 1) {
          await new Promise(() => undefined);
        }
        return 'recovered';
      },
      alwaysFail: async (_call: DurableCall<undefined>) => {
        const attempts =
          (await this.ctx.storage.get<number>('failed-attempts')) ?? 0;
        await this.ctx.storage.put('failed-attempts', attempts + 1);
        throw new Error('still failing');
      },
      once: async (_call: DurableCall<undefined>) => {
        const invocations =
          (await this.ctx.storage.get<number>('once-invocations')) ?? 0;
        await this.ctx.storage.put('once-invocations', invocations + 1);
        return 'done';
      },
      bounded: async (_call: DurableCall<undefined>) => {
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        await new Promise<void>((resolve) => {
          this.releases.push(resolve);
        });
        this.active -= 1;
        return 'done';
      },
      ignoreAbort: async (_call: DurableCall<undefined>) => {
        this.ignoreActive += 1;
        this.ignoreInvocations += 1;
        this.ignoreMaxActive = Math.max(
          this.ignoreMaxActive,
          this.ignoreActive
        );
        await new Promise<void>((resolve) => {
          this.ignoreReleases.push(resolve);
        });
        this.ignoreActive -= 1;
        return 'done';
      },
      versioned: async ({
        operationVersion,
        payloadVersion,
      }: DurableCall<undefined>) => ({
        operationVersion,
        payloadVersion,
      }),
    },
    {
      alarmConcurrency: 1,
      retries: { delay: () => 25, maxAttempts: 2 },
      methods: {
        recover: { payloadSchema: z.string(), resultSchema: z.string() },
        crashAfterClaim: {
          payloadSchema: z.undefined(),
          resultSchema: z.string(),
        },
        alwaysFail: {
          payloadSchema: z.undefined(),
          resultSchema: z.never(),
        },
        once: { payloadSchema: z.undefined(), resultSchema: z.string() },
        bounded: { payloadSchema: z.undefined(), resultSchema: z.string() },
        ignoreAbort: {
          payloadSchema: z.undefined(),
          resultSchema: z.string(),
          attemptTimeoutMs: 25,
          retries: { delay: () => 0, maxAttempts: 2 },
          retryTimeouts: true,
        },
        versioned: {
          payloadSchema: z.undefined(),
          resultSchema: z.object({
            operationVersion: z.string(),
            payloadVersion: z.string(),
          }),
          operationVersion: '2',
          payloadVersion: '2',
          acceptedOperationVersions: ['1'],
          acceptedPayloadVersions: ['1'],
        },
      },
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
        cleanup: { retries: { delay: () => 25, maxAttempts: 2 } },
      },
    }
  );

  scheduleCleanup(scheduledTime: number) {
    return this.durability.alarm.cleanup(scheduledTime);
  }

  getRecorded() {
    return this.ctx.storage.get<RecordedAlarm[]>('recorded');
  }

  registerRecover(id: string) {
    return this.durability.recover({ id, payload: id });
  }

  recoverResult(id: string) {
    return this.durability.recover.getResult(id);
  }

  resetAfterClaim() {
    this.ctx.abort('simulated crash after claim');
  }

  registerCrashAfterClaim(id: string) {
    return this.durability.crashAfterClaim({ id, payload: undefined });
  }

  crashAfterClaimResult(id: string) {
    return this.durability.crashAfterClaim.getResult(id);
  }

  getCrashInvocations() {
    return this.ctx.storage.get<number>('crash-invocations');
  }

  registerFailure(id: string) {
    return this.durability.alwaysFail({ id, payload: undefined });
  }

  failureResult(id: string) {
    return this.durability.alwaysFail.getResult(id);
  }

  registerOnce(id: string) {
    return this.durability.once({ id, payload: undefined });
  }

  getOnceInvocations() {
    return this.ctx.storage.get<number>('once-invocations');
  }

  registerBounded(id: string) {
    return this.durability.bounded({ id, payload: undefined });
  }

  boundedStats() {
    return { active: this.active, maxActive: this.maxActive };
  }

  releaseOne() {
    this.releases.shift()?.();
  }

  registerIgnoreAbort(id: string) {
    return this.durability.ignoreAbort({ id, payload: undefined });
  }

  ignoreAbortResult(id: string) {
    return this.durability.ignoreAbort.getResult(id);
  }

  cancelIgnoreAbort(id: string) {
    return this.durability.ignoreAbort.cancel(id);
  }

  retryIgnoreAbort(id: string) {
    return this.durability.ignoreAbort.retry(id);
  }

  deleteIgnoreAbort(id: string) {
    return this.durability.ignoreAbort.delete(id);
  }

  ignoreAbortStats() {
    return {
      active: this.ignoreActive,
      invocations: this.ignoreInvocations,
      maxActive: this.ignoreMaxActive,
    };
  }

  releaseIgnoreAbort() {
    this.ignoreReleases.shift()?.();
  }

  registerVersion(
    id: string,
    operationVersion: string,
    payloadVersion: string
  ) {
    return this.durability.versioned({
      id,
      payload: undefined,
      operationVersion,
      payloadVersion,
    });
  }

  versionResult(id: string) {
    return this.durability.versioned.getResult(id);
  }

  cancelFailure(id: string) {
    return this.durability.alwaysFail.cancel(id);
  }

  retryFailure(id: string) {
    return this.durability.alwaysFail.retry(id);
  }

  deleteFailure(id: string) {
    return this.durability.alwaysFail.delete(id);
  }

  purgeBefore(timestamp: number) {
    return this.durability.purgeBefore(timestamp);
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
