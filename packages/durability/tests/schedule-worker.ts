import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { DurabilityScheduler } from '../src';
import { DurabilitySchedule } from '../src/experimental';

type Cursor = SqlStorageCursor<Record<string, SqlStorageValue>>;

const bindAll = <Target extends object>(
  target: Target,
  override: (key: string | symbol) => unknown
): Target =>
  new Proxy(target, {
    get(object, key) {
      const replaced = override(key);
      if (replaced !== undefined) {
        return replaced;
      }
      const value: unknown = Reflect.get(object, key);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });

/** Window settings encoded in the schedule expression. */
const windowSchema = z.object({
  every: z.number().int().positive(),
  until: z.number().int().nonnegative(),
});

type Window = z.infer<typeof windowSchema>;

export class ScheduleObject extends DurableObject {
  // Only statements durability issues are counted, not the test's bookkeeping.
  private readonly cursors: Cursor[] = [];
  private setAlarmCount = 0;
  private active = 0;
  private maxActive = 0;

  protected get liveTimers(): boolean {
    return false;
  }

  private readonly scheduler = new DurabilityScheduler({
    context: this.countingContext(),
    alarmMinDelayMs: 1_000,
    liveTimers: this.liveTimers,
  });

  private readonly schedule = new DurabilitySchedule({
    scheduler: this.scheduler,
    maxConcurrentRuns: 2,
    nextOccurrence: (expression, after) => {
      const { every, until } = windowSchema.parse(JSON.parse(expression));
      const next = (Math.floor(after / every) + 1) * every;
      return next <= until ? next : undefined;
    },
    run: async ({ scheduledTime, idempotencyKey }) => {
      this.ctx.storage.sql.exec(
        'INSERT INTO app_runs (scheduled_time, idempotency_key) VALUES (?, ?)',
        scheduledTime,
        idempotencyKey
      );
      const runMs = (await this.ctx.storage.get<number>('run-ms')) ?? 0;
      const hangAt = await this.ctx.storage.get<number>('hang-at');
      if (runMs < 0 || scheduledTime === hangAt) {
        await new Promise(() => undefined);
      }
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      await scheduler.wait(runMs);
      this.active -= 1;
    },
    onOutcome: (run, outcome) => {
      this.ctx.storage.sql.exec(
        `INSERT INTO app_outcomes (scheduled_time, attempt, status, error_name)
         VALUES (?, ?, ?, ?)`,
        run.scheduledTime,
        run.attempt,
        outcome.status,
        outcome.status === 'errored' ? outcome.error.name : null
      );
    },
  });

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS app_runs (scheduled_time INTEGER, idempotency_key TEXT);
      CREATE TABLE IF NOT EXISTS app_outcomes (
        scheduled_time INTEGER, attempt INTEGER, status TEXT, error_name TEXT
      );
    `);
  }

  private countingContext() {
    const sql = bindAll(this.ctx.storage.sql, (key) =>
      key === 'exec'
        ? (query: string, ...bindings: SqlStorageValue[]) => {
            const cursor = this.ctx.storage.sql.exec(query, ...bindings);
            this.cursors.push(cursor);
            return cursor;
          }
        : undefined
    );
    const setAlarm = (
      target: Pick<DurableObjectStorage, 'setAlarm'>,
      scheduledTime: number | Date
    ) => {
      this.setAlarmCount += 1;
      return target.setAlarm(scheduledTime);
    };
    const storage = bindAll(this.ctx.storage, (key) => {
      if (key === 'sql') {
        return sql;
      }
      if (key === 'setAlarm') {
        return (scheduledTime: number | Date) =>
          setAlarm(this.ctx.storage, scheduledTime);
      }
      if (key === 'transaction') {
        return <T>(
          closure: (transaction: DurableObjectTransaction) => Promise<T>
        ) =>
          this.ctx.storage.transaction((transaction) =>
            closure(
              bindAll(transaction, (name) =>
                name === 'setAlarm'
                  ? (scheduledTime: number | Date) =>
                      setAlarm(transaction, scheduledTime)
                  : undefined
              )
            )
          );
      }
      return undefined;
    });
    return {
      storage,
      waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
      id: this.ctx.id,
    };
  }

  /**
   * Runs `count` ticks `every` ms apart and counts rows and alarm writes from
   * then on; a negative `runMs` never settles, and `hangFirst` makes only the
   * first run never settle.
   */
  async start(
    every: number,
    count: number,
    runMs: number,
    hangFirst = false
  ): Promise<number> {
    await this.ctx.storage.put('run-ms', runMs);
    const first = (Math.floor(Date.now() / every) + 1) * every;
    if (hangFirst) {
      await this.ctx.storage.put('hang-at', first);
    }
    const until = first + (count - 1) * every;
    await this.schedule.set({
      expression: JSON.stringify({ every, until } satisfies Window),
      version: 1,
    });
    // Counting starts after `set`, before the first tick can fire.
    this.cursors.length = 0;
    this.setAlarmCount = 0;
    return first;
  }

  rowsWritten(): number {
    return this.cursors.reduce(
      (total, cursor) => total + cursor.rowsWritten,
      0
    );
  }

  setAlarmCalls(): number {
    return this.setAlarmCount;
  }

  physicalAlarm(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  observedMaxActive(): number {
    return this.maxActive;
  }

  runs() {
    return this.ctx.storage.sql
      .exec<{ scheduled_time: number; idempotency_key: string }>(
        'SELECT scheduled_time, idempotency_key FROM app_runs ORDER BY scheduled_time'
      )
      .toArray();
  }

  outcomes() {
    return this.ctx.storage.sql
      .exec<{
        scheduled_time: number;
        attempt: number;
        status: string;
        error_name: string | null;
      }>(
        'SELECT scheduled_time, attempt, status, error_name FROM app_outcomes ORDER BY scheduled_time'
      )
      .toArray();
  }

  pendingRuns(): number {
    return Number(
      this.ctx.storage.sql
        .exec('SELECT COUNT(*) AS count FROM durability_schedule_runs')
        .one()['count']
    );
  }

  nextAt(): number | undefined {
    return this.schedule.get()?.nextAt;
  }

  abort(): void {
    this.ctx.abort('reset');
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export class LiveScheduleObject extends ScheduleObject {
  protected override get liveTimers(): boolean {
    return true;
  }
}
