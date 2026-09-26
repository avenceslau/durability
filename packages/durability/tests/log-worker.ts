import { DurableObject } from 'cloudflare:workers';
import {
  DurabilityLog,
  DurabilityScheduler,
  type LogAppendInput,
  type LogPage,
  type LogRecord,
} from '../src';

export type LogEvent = { topic: string; value: number };

class LogTestObjectBase extends DurableObject {
  protected readonly archived: LogRecord<LogEvent>[] = [];
  protected readonly log: DurabilityLog<LogEvent>;

  constructor(ctx: DurableObjectState, env: unknown, backend: 'sqlite' | 'kv') {
    super(ctx, env as never);
    this.log = new DurabilityLog<LogEvent>({
      scheduler: new DurabilityScheduler({
        context: this.ctx,
        storageBackend: backend,
      }),
      retention: { maxRecords: 3 },
      archive: async (records) => {
        this.archived.push(...records);
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

  archivedOffsets(): number[] {
    return this.archived.map((record) => record.offset);
  }

  load() {
    return this.log.load();
  }
}

export class LogTestObject extends LogTestObjectBase {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env, 'sqlite');
  }
}

export class KvLogTestObject extends LogTestObjectBase {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env, 'kv');
  }
}
