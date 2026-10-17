import { DurableObject } from 'cloudflare:workers';
import { DurabilityOutbox, DurabilityScheduler } from '../src';

export class OutboxObject extends DurableObject {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly outbox = new DurabilityOutbox<number>({
    scheduler: this.scheduler,
    publish: (entries) => {
      for (const entry of entries) {
        this.ctx.storage.sql.exec(
          'INSERT INTO published (key, version, value) VALUES (?, ?, ?)',
          entry.key,
          entry.version,
          entry.value
        );
      }
    },
  });

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS published (key TEXT, version INTEGER, value INTEGER);
    `);
  }

  /** Writes application state and stages it in one transaction. */
  async set(key: string, value: number, fail = false): Promise<boolean> {
    const committed = this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(
        'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        value
      );
      await this.outbox.stage(key, value);
      if (fail) {
        throw new Error('rolled back');
      }
    });
    return committed.then(
      () => true,
      () => false
    );
  }

  counters() {
    return this.ctx.storage.sql
      .exec('SELECT key, value FROM counters')
      .toArray();
  }

  pending() {
    return this.ctx.storage.sql
      .exec('SELECT entry_key AS key, version FROM durability_outbox')
      .toArray();
  }

  published() {
    return this.ctx.storage.sql
      .exec('SELECT key, value FROM published ORDER BY version')
      .toArray();
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}
