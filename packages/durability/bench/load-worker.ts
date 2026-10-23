import { DurableObject } from 'cloudflare:workers';
import {
  Durability,
  DurabilityAlarms,
  DurabilityScheduler,
  type DurableCall,
} from '../src';

export type LoadPayload = {
  /** Fail every attempt whose number is at or below this value, then succeed. */
  failUntil?: number;
  /** Await this many milliseconds inside the handler to force overlap. */
  holdMs?: number;
  /** Extra bytes carried in the payload to grow stored rows. */
  filler?: string;
};

export type LoadReport = {
  completed: number;
  failed: number;
  operationAttempts: number;
  alarmAttempts: number;
  maxConcurrent: number;
  maxOperationConcurrent: number;
  maxAlarmConcurrent: number;
  physicalAlarmInvocations: number;
  callRows: number;
  alarmRows: number;
  databaseSize: number;
  bytesPerCallRow: number;
  seedMs: number;
  drainMs: number;
  pendingAtDeadline: number;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class LoadTestObject extends DurableObject {
  private concurrent = 0;
  private operationConcurrent = 0;
  private alarmConcurrent = 0;
  private maxConcurrent = 0;
  private maxOperationConcurrent = 0;
  private maxAlarmConcurrent = 0;
  private completed = 0;
  private failed = 0;
  private operationAttempts = 0;
  private alarmAttempts = 0;
  private physicalAlarmInvocations = 0;

  private readonly scheduler = new DurabilityScheduler({
    context: this.ctx,
    alarmConcurrency: 10,
    alarmMinDelayMs: 1_000,
  });

  private readonly durability = new Durability({
    scheduler: this.scheduler,
    handlers: {
      job: async ({ attempt, payload }: DurableCall<LoadPayload>) => {
        this.operationAttempts += 1;
        this.enter('operation');
        try {
          if (payload.failUntil !== undefined && attempt <= payload.failUntil) {
            throw new Error(`forced failure on attempt ${attempt}`);
          }
          if (payload.holdMs) {
            await sleep(payload.holdMs);
          }
          this.completed += 1;
        } finally {
          this.leave('operation');
        }
      },
    },
    methods: {
      job: { retries: { delay: () => 0, maxAttempts: 25 } },
    },
    onLifecycleEvent: (event) => {
      if (event.type === 'terminal') {
        this.failed += 1;
      }
    },
  });

  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: {
      tick: async ({ attempt }) => {
        this.alarmAttempts += 1;
        this.enter('alarm');
        try {
          if (attempt <= 1) {
            await sleep(5);
          }
        } finally {
          this.leave('alarm');
        }
      },
    },
  });

  private enter(kind: 'operation' | 'alarm'): void {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    if (kind === 'operation') {
      this.operationConcurrent += 1;
      this.maxOperationConcurrent = Math.max(
        this.maxOperationConcurrent,
        this.operationConcurrent
      );
    } else {
      this.alarmConcurrent += 1;
      this.maxAlarmConcurrent = Math.max(
        this.maxAlarmConcurrent,
        this.alarmConcurrent
      );
    }
  }

  private leave(kind: 'operation' | 'alarm'): void {
    this.concurrent -= 1;
    if (kind === 'operation') {
      this.operationConcurrent -= 1;
    } else {
      this.alarmConcurrent -= 1;
    }
  }

  private count(table: string): number {
    const [row] = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
      .toArray();
    return row?.n ?? 0;
  }

  private pending(): number {
    const [row] = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM durability_calls WHERE status = 'pending'`
      )
      .toArray();
    return row?.n ?? 0;
  }

  async run(input: {
    count: number;
    failUntil?: number;
    holdMs?: number;
    fillerBytes?: number;
    alarmCount?: number;
    drainTimeoutMs?: number;
  }): Promise<LoadReport> {
    const filler =
      input.fillerBytes && input.fillerBytes > 0
        ? 'x'.repeat(input.fillerBytes)
        : undefined;

    const seedStart = Date.now();
    for (let index = 0; index < input.count; index += 1) {
      const payload: LoadPayload = {};
      if (input.failUntil !== undefined) {
        payload.failUntil = input.failUntil;
      }
      if (input.holdMs !== undefined) {
        payload.holdMs = input.holdMs;
      }
      if (filler !== undefined) {
        payload.filler = filler;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.durability.job({ id: `job:${index}`, payload });
    }
    for (let index = 0; index < (input.alarmCount ?? 0); index += 1) {
      // Named alarms are singletons per name; one handler drives every tick.
      // eslint-disable-next-line no-await-in-loop
      await this.alarms.tick(Date.now());
    }
    const seedMs = Date.now() - seedStart;

    const drainStart = Date.now();
    const deadline = drainStart + (input.drainTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (this.pending() === 0 && this.concurrent === 0) {
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(10);
    }
    const drainMs = Date.now() - drainStart;

    const callRows = this.count('durability_calls');
    const alarmRows = this.count('durability_alarms');
    const databaseSize = this.ctx.storage.sql.databaseSize;

    return {
      completed: this.completed,
      failed: this.failed,
      operationAttempts: this.operationAttempts,
      alarmAttempts: this.alarmAttempts,
      maxConcurrent: this.maxConcurrent,
      maxOperationConcurrent: this.maxOperationConcurrent,
      maxAlarmConcurrent: this.maxAlarmConcurrent,
      physicalAlarmInvocations: this.physicalAlarmInvocations,
      callRows,
      alarmRows,
      databaseSize,
      bytesPerCallRow:
        callRows > 0 ? Math.round(databaseSize / callRows) : databaseSize,
      seedMs,
      drainMs,
      pendingAtDeadline: this.pending(),
    };
  }

  override alarm(info?: AlarmInvocationInfo) {
    this.physicalAlarmInvocations += 1;
    return this.scheduler.alarm(info);
  }
}

export default {
  fetch() {
    return new Response('Not found', { status: 404 });
  },
};
