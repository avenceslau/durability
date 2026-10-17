import { DurableObject } from 'cloudflare:workers';
import { timeout } from '@durability/transforms';
import {
  DurabilityAlarms,
  DurabilityLog,
  DurabilityScheduler,
  type LogAppendInput,
  type LogPage,
  type LogRecord,
} from 'durability';
import { DurabilityRouting } from 'durability/routing';

type Env = {
  COLD: R2Bucket;
  PARTITIONS: DurableObjectNamespace<Partition>;
};

type Event = {
  topic: string;
  /** Events sharing a partition key land on the same partition. */
  partitionKey: string;
  /** Already-encoded body: a log stores bytes, not the producer's types. */
  payload: string;
};

type Append = {
  events: LogAppendInput<Event>[];
  region?: DurableObjectLocationHint;
};

/** Partitions per topic. Adding one is a routing decision, not a deploy. */
const partitionCount = 8;
const coldPrefix = 'segments/';
// Retention deletes by age and count. It is not Kafka-style key compaction,
// which keeps the latest record per key and is not implemented here.
const retentionSweepMs = 60_000;

const partitionFor = (key: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash) % partitionCount;
};

/**
 * One partition of one topic. The application owns this class and composes the
 * capabilities it wants: a log for retained history, alarms for compaction, and
 * routing's load observer so producers can see this partition's backlog.
 */
export class Partition extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly routing = new DurabilityRouting();
  private readonly log = new DurabilityLog<Event>({
    scheduler: this.scheduler,
    routing: this.routing,
    retention: {
      maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxRecords: 50_000,
      // The object keeps a hot window; everything older lives in R2.
      maxBytes: 256 * 1024 * 1024,
    },
    // Flushed segments stay readable, so a consumer that falls behind the hot
    // window is served from R2 instead of losing records.
    cold: {
      write: async ({ records, firstOffset }) => {
        const locator = `${coldPrefix}${this.ctx.id.toString()}/${firstOffset}`;
        await this.env.COLD.put(locator, JSON.stringify(records), {
          onlyIf: { etagDoesNotMatch: '*' },
        });
        return locator;
      },
      read: async (locator) => {
        const stored = await this.env.COLD.get(locator);
        return stored ? await stored.json<LogRecord<Event>[]>() : undefined;
      },
    },
  });

  // Retention needs a schedule, and a named alarm is that schedule.
  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: {
      enforceRetention: async () => {
        await this.log.trim();
        // Compare the hot window, not the oldest readable offset: flushed
        // segments keep that one low forever, which would sweep forever.
        const { hotOffset, nextOffset } = await this.log.bounds();
        if (hotOffset < nextOffset) {
          await this.alarms.enforceRetention(Date.now() + retentionSweepMs);
          return;
        }
        // Nothing left to expire, so stop re-arming and let the partition
        // hibernate until the next append schedules another sweep.
        await this.ctx.storage.delete('sweeping');
      },
    },
  });

  /** Producers reach this through routing; the result carries acceptance + load. */
  async append(batch: Append) {
    const result = await this.log.append(batch.events);
    // Scheduling a named alarm replaces its pending time, so re-arming on
    // every append would postpone retention for as long as traffic continues.
    if (result.success && !(await this.ctx.storage.get<boolean>('sweeping'))) {
      await this.ctx.storage.put('sweeping', true);
      await this.alarms.enforceRetention(Date.now() + retentionSweepMs);
    }
    return result;
  }

  /**
   * Consumers pull. A group's cursor is the only thing that advances, and a
   * cursor below the hot window is served from R2 rather than failing.
   */
  async consume(group: string, limit: number): Promise<LogPage<Event>> {
    // A new group starts at the oldest readable record, flushed or not.
    const from =
      (await this.log.cursor(group)) ?? (await this.log.bounds()).oldestOffset;
    return this.log.read({ from, limit });
  }

  /**
   * Mirrors the bucket's lifecycle rule. R2 expires the objects on its own
   * schedule, so the index must forget the same segments or a read would
   * chase a locator whose object is gone.
   */
  expireCold(before: number) {
    return this.log.forgetColdBefore(before);
  }

  /** Acknowledging is separate from reading, so a crash re-reads the page. */
  commit(group: string, offset: number) {
    return this.log.commit(group, offset);
  }

  cursors() {
    return this.log.cursors();
  }

  bounds() {
    return this.log.bounds();
  }

  load() {
    return this.log.load();
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

/**
 * Stands in for the consumer's real work. Records arrive in offset order
 * within a partition, and may be redelivered after a failure.
 */
const handle = async (records: LogRecord<Event>[]): Promise<void> => {
  for (const record of records) {
    console.log(`handled ${record.offset} of ${record.body.topic}`);
  }
};

/**
 * Producer side. The shard key is `topic:partition`, so topics are created by
 * writing to them: no partition table, no rebalance, and idle partitions
 * hibernate. `invoke` picks the application method, so routing works with the
 * log exactly as it does with fanout.
 */
const topics = DurabilityRouting.client({
  target: Partition,
  invoke: (stub, input: Append) => stub.append(input),
  sharding: (input) => {
    const first = input.events[0]?.body;
    if (!first) {
      throw new Error('An append must carry at least one event');
    }
    const shard = `${first.topic}:${partitionFor(first.partitionKey)}`;
    return input.region === undefined
      ? shard
      : { shard, locationHint: input.region };
  },
});

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const topic = url.searchParams.get('topic') ?? 'events';

    // Demo input only: authenticate and validate untrusted payloads.
    if (request.method === 'POST') {
      const events = await request.json<
        Array<{ partitionKey: string; payload: string; key?: string }>
      >();
      // A batch must share a partition, so group by key before pushing.
      const byPartition = new Map<string, LogAppendInput<Event>[]>();
      for (const event of events) {
        const shard = `${topic}:${partitionFor(event.partitionKey)}`;
        const body: Event = {
          topic,
          partitionKey: event.partitionKey,
          payload: event.payload,
        };
        byPartition.set(shard, [
          ...(byPartition.get(shard) ?? []),
          event.key === undefined
            ? { body }
            : { deduplicationKey: event.key, body },
        ]);
      }
      const accepted = await Promise.all(
        [...byPartition.values()].map((group) =>
          topics.with(timeout, 5_000).push({ events: group })
        )
      );
      // A rejected push is definite; a thrown one is uncertain and may retry.
      return Response.json(accepted, {
        status: accepted.every((result) => result.success) ? 202 : 409,
      });
    }

    if (request.method !== 'GET') {
      return new Response('POST events or GET ?group=', { status: 405 });
    }

    // Each partition is polled independently: a slow group never blocks others.
    const group = url.searchParams.get('group') ?? 'default';
    const partitions = [...Array(partitionCount).keys()].map((index) =>
      env.PARTITIONS.getByName(`${topic}:${index}`)
    );
    const pages = await Promise.all(
      partitions.map(async (stub) => {
        const page = await stub.consume(group, 100);
        if (page.records.length === 0) {
          return { nextOffset: page.nextOffset, lag: page.lag, handled: 0 };
        }
        // Commit only once the work succeeded. Committing first would make
        // this at-most-once, silently skipping a page on a crash. Throwing
        // instead re-reads it, so processing must tolerate duplicates.
        await handle(page.records);
        await stub.commit(group, page.nextOffset);
        return {
          nextOffset: page.nextOffset,
          lag: page.lag,
          handled: page.records.length,
        };
      })
    );
    return Response.json(pages);
  },
} satisfies ExportedHandler<Env>;
