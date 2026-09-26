import { DurableObject } from 'cloudflare:workers';
import {
  DurabilityLog,
  DurabilityScheduler,
  type LogAppendInput,
  type LogPage,
  type LogRecord,
} from '../src';

type Env = { DEAD_LETTERS: R2Bucket };

const segmentPrefix = 'log-segments/';

export type LogEvent = { topic: string; value: number };

class LogTestObjectBase extends DurableObject<Env> {
  protected readonly log: DurabilityLog<LogEvent>;

  constructor(ctx: DurableObjectState, env: Env, backend: 'sqlite' | 'kv') {
    super(ctx, env);
    this.log = new DurabilityLog<LogEvent>({
      scheduler: new DurabilityScheduler({
        context: this.ctx,
        storageBackend: backend,
      }),
      retention: { maxRecords: 3 },
      // Real cold storage: one immutable object per flushed segment.
      cold: {
        write: async ({ records, firstOffset }) => {
          const locator = `${segmentPrefix}${this.ctx.id.toString()}/${firstOffset}`;
          await this.env.DEAD_LETTERS.put(locator, JSON.stringify(records), {
            onlyIf: { etagDoesNotMatch: '*' },
          });
          return locator;
        },
        read: async (locator) => {
          const stored = await this.env.DEAD_LETTERS.get(locator);
          return stored
            ? await stored.json<LogRecord<LogEvent>[]>()
            : undefined;
        },
      },
    });
  }

  append(records: LogAppendInput<LogEvent>[]) {
    return this.log.append(records);
  }

  read(from: number, limit?: number): Promise<LogPage<LogEvent>> {
    return this.log.read({ from, ...(limit === undefined ? {} : { limit }) });
  }

  commit(consumer: string, offset: number) {
    return this.log.commit(consumer, offset);
  }

  cursors() {
    return this.log.cursors();
  }

  bounds() {
    return this.log.bounds();
  }

  trim() {
    return this.log.trim();
  }

  forgetColdBefore(offset: number) {
    return this.log.forgetColdBefore(offset);
  }

  load() {
    return this.log.load();
  }
}

export class LogTestObject extends LogTestObjectBase {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, 'sqlite');
  }
}

export class KvLogTestObject extends LogTestObjectBase {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, 'kv');
  }
}
