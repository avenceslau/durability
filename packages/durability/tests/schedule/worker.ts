import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { DurabilityScheduler } from '../../src';
import {
  DurabilitySchedule,
  type ScheduleDefinition,
} from '../../src/experimental';
import { isFunction } from '../../src/predicates';

type Cursor = SqlStorageCursor<Record<string, SqlStorageValue>>;

const bindAll = <Target extends object>(
  target: Target,
  override: (key: string | symbol) => Partial<Target>[keyof Target]
): Target =>
  new Proxy(target, {
    get(object, key) {
      const replaced = override(key);

      if (replaced !== undefined) {
        return replaced;
      }

      const value: unknown = Reflect.get(object, key);

      return isFunction(value) ? value.bind(object) : value;
    },
  });

/** Window settings encoded in the schedule expression. */
const windowSchema = v.object({
  every: v.pipe(v.number(), v.safeInteger(), v.gtValue(0)),
  until: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

type Window = v.InferOutput<typeof windowSchema>;

export class ScheduleObject extends DurableObject {
  // Only statements durability issues are counted, not the test's bookkeeping.
  private readonly cursors: Cursor[] = [];
  private setAlarmCount = 0;
  private active = 0;
  private maxActive = 0;
  private queuedRuns = 0;
  private hangUntilReset = false;

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
      const { every, until } = v.parse(windowSchema, JSON.parse(expression));
      const next = (Math.floor(after / every) + 1) * every;

      return next <= until ? next : undefined;
    },
    run: async ({ scheduledTime, dueAt, idempotencyKey }) => {
      this.ctx.storage.sql.exec(
        `INSERT INTO app_runs (
           scheduled_time,
           idempotency_key,
           due_at,
           started_at
         )
         VALUES (?, ?, ?, ?)`,
        scheduledTime,
        idempotencyKey,
        dueAt,
        Date.now()
      );
      const runMs = (await this.ctx.storage.get<number>('run-ms')) ?? 0;

      if (runMs < 0 || this.hangUntilReset) {
        await new Promise(() => undefined);
      }

      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      await scheduler.wait(runMs);
      this.active -= 1;
    },
    onLifecycleEvent: (event) => {
      if (event.type === 'due' && event.queued) {
        this.queuedRuns += 1;
      }
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
      CREATE TABLE IF NOT EXISTS app_runs (
        scheduled_time INTEGER,
        idempotency_key TEXT,
        due_at INTEGER,
        started_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS app_outcomes (
        scheduled_time INTEGER, attempt INTEGER, status TEXT, error_name TEXT
      );
    `);
  }

  private countingContext() {
    const sql = bindAll(this.ctx.storage.sql, (key) =>
      key === 'exec'
        ? <Row extends Record<string, SqlStorageValue>>(
            query: string,
            ...bindings: SqlStorageValue[]
          ) => {
            const cursor = this.ctx.storage.sql.exec<Row>(query, ...bindings);
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
   * then on; a negative `runMs` never settles, and `hangUntilReset` makes every
   * run this instance starts never settle, while runs after a reset do.
   */
  async start(
    every: number,
    count: number,
    runMs: number,
    hangUntilReset = false,
    jitterMs = 0
  ): Promise<number> {
    await this.ctx.storage.put('run-ms', runMs);
    this.hangUntilReset = hangUntilReset;

    // Time passes between picking the first tick and storing the schedule, so
    // a slow host can store a later one; a newer version picks again.
    for (let version = 1; ; version += 1) {
      const first = (Math.floor(Date.now() / every) + 1) * every;
      const until = first + (count - 1) * every;

      // eslint-disable-next-line no-await-in-loop
      await this.schedule.set({
        expression: JSON.stringify({ every, until } satisfies Window),
        version,
        jitterMs,
      });

      if (this.schedule.get()?.nextAt === first) {
        // Counting starts after `set`, before the first tick can fire.
        this.cursors.length = 0;
        this.setAlarmCount = 0;

        return first;
      }
    }
  }

  async configure(definition: ScheduleDefinition) {
    const applied = await this.schedule.set(definition);

    return { applied, state: this.schedule.get() };
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

  /** Runs that waited for a free slot, each costing one more row write. */
  queuedRunCount(): number {
    return this.queuedRuns;
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

  firings() {
    return this.ctx.storage.sql
      .exec<{
        scheduled_time: number;
        due_at: number;
        started_at: number;
      }>(
        `SELECT
           scheduled_time,
           due_at,
           started_at
         FROM app_runs
         ORDER BY scheduled_time`
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

  async abort(): Promise<void> {
    await this.ctx.storage.sync();
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
