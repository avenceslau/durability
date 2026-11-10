import { DurableObject } from 'cloudflare:workers';
import {
  DurabilityLog,
  DurabilityScheduler,
  type LogAppendInput,
  type LogColdStorage,
  type LogPage,
  type LogRecord,
} from '../src';

type Env = { DEAD_LETTERS: R2Bucket };

const segmentPrefix = 'log-segments/';

export type LogEvent = { topic: string; value: number };

/** Contains NUL so it would collide with any naive key concatenation. */
export const peerChannel = 'peer\u0000log';

export class LogTestObject extends DurableObject<Env> {
  protected readonly log: DurabilityLog<LogEvent>;
  private readonly peer: DurabilityLog<LogEvent>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const scheduler = new DurabilityScheduler({ context: this.ctx });
    // Real cold storage: one immutable object per flushed segment. Channels
    // count offsets separately, so the key includes the channel.
    const cold: LogColdStorage<LogEvent> = {
      write: async ({ channel, records, firstOffset }) => {
        const locator = `${segmentPrefix}${this.ctx.id.toString()}/${encodeURIComponent(channel)}/${firstOffset}`;
        await this.env.DEAD_LETTERS.put(locator, JSON.stringify(records), {
          onlyIf: { etagDoesNotMatch: '*' },
        });
        return locator;
      },
      read: async (locator) => {
        const stored = await this.env.DEAD_LETTERS.get(locator);
        return stored ? await stored.json<LogRecord<LogEvent>[]>() : undefined;
      },
    };
    this.log = new DurabilityLog<LogEvent>({
      scheduler,
      retention: { maxRecords: 3 },
      leases: { maxParallelism: 2, leaseMs: 1_000 },
      cold,
    });
    this.peer = new DurabilityLog<LogEvent>({
      scheduler,
      channel: peerChannel,
      retention: { maxRecords: 1 },
      leases: { leaseMs: 1_000 },
      cold,
    });
  }

  appendPeer(records: LogAppendInput<LogEvent>[]) {
    return this.peer.append(records);
  }

  readPeer(from: number): Promise<LogPage<LogEvent>> {
    return this.peer.read({ from });
  }

  trimPeer() {
    return this.peer.trim();
  }

  leasePeer(consumer: string) {
    return this.peer.lease(consumer);
  }

  ackPeer(consumer: string, batchId: string) {
    return this.peer.ack(consumer, batchId);
  }

  cursorPeer(consumer: string) {
    return this.peer.cursor(consumer);
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

  lease(consumer: string, limit?: number) {
    return this.log.lease(consumer, limit);
  }

  ackLease(consumer: string, batchId: string) {
    return this.log.ack(consumer, batchId);
  }

  nackLease(consumer: string, batchId: string) {
    return this.log.nack(consumer, batchId);
  }

  cursor(consumer: string) {
    return this.log.cursor(consumer);
  }

  forgetColdBefore(offset: number) {
    return this.log.forgetColdBefore(offset);
  }

  load() {
    return this.log.load();
  }
}
