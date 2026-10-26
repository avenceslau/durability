import { DurableObject } from 'cloudflare:workers';
import {
  Durability,
  DurabilityAlarms,
  DurabilityScheduler,
  type DurableCall,
} from '../src';

export class LiveTimersObject extends DurableObject {
  private readonly scheduler = new DurabilityScheduler({
    context: this.ctx,
    alarmMinDelayMs: 1_000,
    liveTimers: true,
  });

  private readonly durability = new Durability({
    scheduler: this.scheduler,
    handlers: {
      long: async ({ attempt }: DurableCall<null>) => {
        this.record('long', attempt);
        await new Promise(() => undefined);
      },
    },
    methods: { long: { retries: { maxAttempts: 1 } } },
  });

  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: {
      tick: async ({ scheduledTime }) => {
        this.record('tick', scheduledTime);
      },
    },
  });

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS app_runs (name TEXT, value INTEGER)'
    );
  }

  private record(name: string, value: number): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO app_runs (name, value) VALUES (?, ?)',
      name,
      value
    );
  }

  startLong(): Promise<void> {
    return this.durability.long({ id: 'long', payload: null });
  }

  scheduleTick(scheduledTime: number): Promise<void> {
    return this.alarms.tick(scheduledTime);
  }

  longResult() {
    return this.durability.long.getResult('long');
  }

  runs() {
    return this.ctx.storage.sql
      .exec<{ name: string; value: number }>(
        'SELECT name, value FROM app_runs ORDER BY rowid'
      )
      .toArray();
  }

  physicalAlarm(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  abort(): void {
    this.ctx.abort('reset');
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}
