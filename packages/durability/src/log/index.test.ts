import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DurabilityLog,
  LogLeaseError,
  LogTruncatedError,
  maxLogBytes,
} from '../index';
import type { LogColdStorage, LogRecord, LogSegment } from './index';
import { durabilityLogLeaseMigrations, migrateCapability } from '../migrations';
import { serialize } from '../serialization';
import { contextFor, FakeStorage } from '../test-fakes';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('log', () => {
  const fixture = (
    options: Partial<
      Pick<
        ConstructorParameters<typeof DurabilityLog<string>>[0],
        'retention' | 'cold' | 'maxBatchSize' | 'leases'
      >
    > = {}
  ) => {
    const storage = new FakeStorage();
    const log = new DurabilityLog<string>({
      context: { storage: storage as unknown as DurableObjectStorage },
      ...options,
    });
    return { log, storage };
  };

  const offsetsOf = async (
    log: DurabilityLog<string>,
    bodies: string[]
  ): Promise<number[]> => {
    const result = await log.append(bodies.map((body) => ({ body })));
    if (!result.success) {
      throw new Error(`append rejected: ${result.error.message}`);
    }
    return result.value;
  };

  it('assigns contiguous offsets and reads them back in order', async () => {
    const { log } = fixture();
    expect(await offsetsOf(log, ['a', 'b'])).toEqual([0, 1]);
    expect(await offsetsOf(log, ['c'])).toEqual([2]);

    const page = await log.read({ from: 0 });
    expect(page.records.map((record) => record.body)).toEqual(['a', 'b', 'c']);
    expect(page.records.map((record) => record.offset)).toEqual([0, 1, 2]);
    expect(page).toMatchObject({ nextOffset: 3, lag: 0 });
    expect(await log.bounds()).toEqual({
      oldestOffset: 0,
      hotOffset: 0,
      nextOffset: 3,
    });
  });

  it('reports lag and resumes from the returned offset', async () => {
    const { log } = fixture();
    await offsetsOf(log, ['a', 'b', 'c', 'd']);

    const first = await log.read({ from: 0, limit: 2 });
    expect(first.records.map((record) => record.body)).toEqual(['a', 'b']);
    expect(first).toMatchObject({ nextOffset: 2, lag: 2 });

    const second = await log.read({ from: first.nextOffset, limit: 2 });
    expect(second.records.map((record) => record.body)).toEqual(['c', 'd']);
    expect(second).toMatchObject({ nextOffset: 4, lag: 0 });

    const empty = await log.read({ from: second.nextOffset });
    expect(empty).toMatchObject({ records: [], nextOffset: 4, lag: 0 });
  });

  it('retains records so independent consumers replay the same history', async () => {
    const { log } = fixture();
    await offsetsOf(log, ['a', 'b']);

    expect(await log.cursor('search')).toBeUndefined();
    await log.commit('search', 2);
    await log.commit('billing', 1);
    expect(await log.cursors()).toEqual({ billing: 1, search: 2 });

    // Acknowledgement does not consume: a late consumer still sees history.
    expect((await log.read({ from: 0 })).records).toHaveLength(2);
  });

  it('ignores cursor regressions so a late commit cannot rewind', async () => {
    const { log } = fixture();
    await offsetsOf(log, ['a', 'b', 'c']);
    await log.commit('search', 3);
    await log.commit('search', 1);
    expect(await log.cursor('search')).toBe(3);
  });

  it('reuses the offset of an already appended key', async () => {
    const { log } = fixture();
    const first = await log.append([
      { deduplicationKey: 'one', body: 'a' },
      { deduplicationKey: 'two', body: 'b' },
    ]);
    const repeat = await log.append([
      { deduplicationKey: 'two', body: 'b' },
      { deduplicationKey: 'three', body: 'c' },
    ]);
    expect(first).toMatchObject({ success: true, value: [0, 1] });
    expect(repeat).toMatchObject({ success: true, value: [1, 2] });

    const page = await log.read({ from: 0 });
    expect(page.records.map((record) => record.deduplicationKey)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('shares one offset between duplicate keys in a single batch', async () => {
    const { log } = fixture();
    const result = await log.append([
      { deduplicationKey: 'same', body: 'a' },
      { deduplicationKey: 'same', body: 'a' },
    ]);
    expect(result).toMatchObject({ success: true, value: [0, 0] });
    expect((await log.read({ from: 0 })).records).toHaveLength(1);
    expect(await log.bounds()).toEqual({
      oldestOffset: 0,
      hotOffset: 0,
      nextOffset: 1,
    });
  });

  it('rejects definite input errors without throwing', async () => {
    const { log } = fixture({ maxBatchSize: 2 });
    expect(await log.append([])).toMatchObject({
      success: false,
      error: { name: 'LogAppendError' },
    });
    expect(
      await log.append([{ body: 'a' }, { body: 'b' }, { body: 'c' }])
    ).toMatchObject({ success: false, error: { name: 'LogAppendError' } });
    expect(await log.bounds()).toEqual({
      oldestOffset: 0,
      hotOffset: 0,
      nextOffset: 0,
    });
  });

  it('trims by age and reports the surviving window', async () => {
    const { log } = fixture({ retention: { maxAgeMs: 60_000 } });
    await offsetsOf(log, ['a', 'b']);
    vi.advanceTimersByTime(90_000);
    await offsetsOf(log, ['c']);

    expect(await log.trim()).toBe(2);
    expect(await log.bounds()).toEqual({
      oldestOffset: 2,
      hotOffset: 2,
      nextOffset: 3,
    });
    expect((await log.read({ from: 2 })).records.map((r) => r.body)).toEqual([
      'c',
    ]);
  });

  it('trims by record count, oldest first', async () => {
    const { log } = fixture({ retention: { maxRecords: 2 } });
    await offsetsOf(log, ['a', 'b', 'c', 'd']);
    expect(await log.trim()).toBe(2);
    expect((await log.read({ from: 2 })).records.map((r) => r.body)).toEqual([
      'c',
      'd',
    ]);
  });

  it('tells a consumer that fell behind retention that it lost records', async () => {
    const { log } = fixture({ retention: { maxRecords: 1 } });
    await offsetsOf(log, ['a', 'b']);
    await log.trim();

    await expect(log.read({ from: 0 })).rejects.toThrow(LogTruncatedError);
    await expect(log.read({ from: 0 })).rejects.toThrow(
      /oldest retained offset is 1/
    );
    expect((await log.read({ from: 1 })).records).toHaveLength(1);
  });

  it('flushes expiring records before deleting them', async () => {
    const archived: LogRecord<string>[] = [];
    const { log } = fixture({
      retention: { maxRecords: 1 },
      cold: {
        write: async ({ records, firstOffset }) => {
          archived.push(...records);
          return `segment-${firstOffset}`;
        },
        read: async () => undefined,
      },
    });
    await offsetsOf(log, ['a', 'b', 'c']);
    expect(await log.trim()).toBe(2);
    expect(archived.map((record) => [record.offset, record.body])).toEqual([
      [0, 'a'],
      [1, 'b'],
    ]);
  });

  it('retains records when the cold write fails', async () => {
    const { log } = fixture({
      retention: { maxRecords: 1 },
      cold: {
        write: async () => {
          throw new Error('cold storage unavailable');
        },
        read: async () => undefined,
      },
    });
    await offsetsOf(log, ['a', 'b']);
    await expect(log.trim()).rejects.toThrow('cold storage unavailable');
    expect(await log.bounds()).toEqual({
      oldestOffset: 0,
      hotOffset: 0,
      nextOffset: 2,
    });
  });

  it('archives each expiring record exactly once past a delete batch', async () => {
    const archived: number[] = [];
    const { log } = fixture({
      retention: { maxRecords: 1 },
      cold: {
        write: async ({ records, firstOffset }) => {
          archived.push(...records.map((record) => record.offset));
          return `segment-${firstOffset}`;
        },
        read: async () => undefined,
      },
    });
    // More records than one backend delete call accepts, so a backend that
    // silently truncated the trim would re-archive the remainder.
    for (let batch = 0; batch < 6; batch += 1) {
      // eslint-disable-next-line no-await-in-loop
      await offsetsOf(log, ['a', 'b', 'c', 'd', 'e']);
    }
    expect(await log.trim()).toBe(29);
    expect(archived).toHaveLength(29);
    expect(new Set(archived).size).toBe(29);
    // Flushed records stay readable, so only the hot window advanced.
    expect(await log.bounds()).toEqual({
      oldestOffset: 0,
      hotOffset: 29,
      nextOffset: 30,
    });
  });

  it('keeps everything without retention configured', async () => {
    const { log } = fixture();
    await offsetsOf(log, ['a', 'b']);
    expect(await log.trim()).toBe(0);
    expect((await log.read({ from: 0 })).records).toHaveLength(2);
  });

  /** Records what was flushed and hands it back, like an R2 bucket would. */
  const coldStore = (): LogColdStorage<string> & {
    segments: Map<string, LogRecord<string>[]>;
  } => {
    const segments = new Map<string, LogRecord<string>[]>();
    return {
      segments,
      write: async ({ records, firstOffset }) => {
        const locator = `segment-${firstOffset}`;
        segments.set(locator, records);
        return locator;
      },
      read: async (locator) => segments.get(locator),
    };
  };

  it('flushes by byte budget and keeps flushed offsets readable', async () => {
    const cold = coldStore();
    // Each serialized record is a handful of bytes, so a tiny budget forces
    // a flush after the first few appends.
    const { log } = fixture({ retention: { maxBytes: 12 }, cold });
    await offsetsOf(log, ['aaa', 'bbb', 'ccc', 'ddd']);

    expect(await log.trim()).toBeGreaterThan(0);
    const bounds = await log.bounds();
    expect(bounds.oldestOffset).toBe(0);
    expect(bounds.hotOffset).toBeGreaterThan(0);
    expect(cold.segments.size).toBeGreaterThan(0);

    // Reading below the hot window rehydrates instead of failing.
    const page = await log.read({ from: 0 });
    expect(page.records[0]).toMatchObject({ offset: 0, body: 'aaa' });
  });

  it('rehydrates a flushed page and resumes into hot records', async () => {
    const cold = coldStore();
    const { log } = fixture({ retention: { maxRecords: 1 }, cold });
    await offsetsOf(log, ['a', 'b', 'c']);
    expect(await log.trim()).toBe(2);

    const flushed = await log.read({ from: 0, limit: 2 });
    expect(flushed.records.map((record) => record.body)).toEqual(['a', 'b']);
    expect(flushed.nextOffset).toBe(2);

    const hot = await log.read({ from: flushed.nextOffset });
    expect(hot.records.map((record) => record.body)).toEqual(['c']);
    expect(hot.lag).toBe(0);
  });

  it('truncates once flushed segments are forgotten', async () => {
    const cold = coldStore();
    const { log } = fixture({ retention: { maxRecords: 1 }, cold });
    await offsetsOf(log, ['a', 'b']);
    await log.trim();
    expect((await log.read({ from: 0 })).records).toHaveLength(1);

    expect(await log.forgetColdBefore(1)).toBe(1);
    await expect(log.read({ from: 0 })).rejects.toThrow(LogTruncatedError);
  });

  it('truncates when cold storage lost a segment it indexed', async () => {
    const cold = coldStore();
    const { log } = fixture({ retention: { maxRecords: 1 }, cold });
    await offsetsOf(log, ['a', 'b']);
    await log.trim();
    cold.segments.clear();
    await expect(log.read({ from: 0 })).rejects.toThrow(LogTruncatedError);
  });

  it('deletes rather than flushes without cold storage', async () => {
    const { log } = fixture({ retention: { maxBytes: 8 } });
    await offsetsOf(log, ['aaaa', 'bbbb', 'cccc']);
    expect(await log.trim()).toBeGreaterThan(0);
    const bounds = await log.bounds();
    expect(bounds.oldestOffset).toBe(bounds.hotOffset);
    await expect(log.read({ from: 0 })).rejects.toThrow(LogTruncatedError);
  });

  it('rejects a byte budget above the per-object cap', () => {
    expect(() => fixture({ retention: { maxBytes: maxLogBytes + 1 } })).toThrow(
      /maxBytes/
    );
  });

  it('handles many flushed segments', async () => {
    const cold = coldStore();
    // One record per segment.
    const { log } = fixture({
      maxBatchSize: 1,
      retention: { maxRecords: 1 },
      cold,
    });
    for (let index = 0; index < 150; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await offsetsOf(log, [`v${index}`]);
      // eslint-disable-next-line no-await-in-loop
      await log.trim();
    }
    expect(cold.segments.size).toBe(149);
    expect((await log.read({ from: 0 })).records[0]).toMatchObject({
      offset: 0,
      body: 'v0',
    });
    expect((await log.read({ from: 140 })).records[0]).toMatchObject({
      offset: 140,
      body: 'v140',
    });
    expect(await log.forgetColdBefore(149)).toBe(149);
    await expect(log.read({ from: 0 })).rejects.toThrow(LogTruncatedError);
  });

  it('never hands the same offsets to two concurrent consumers', async () => {
    const { log } = fixture({ leases: {} });
    await offsetsOf(log, ['a', 'b', 'c', 'd']);

    const first = await log.lease('search', 2);
    // A second poller of the same consumer gets nothing while the first
    // holds its range: this is the double-processing that plain reads allow.
    expect(await log.lease('search', 2)).toBeUndefined();
    expect(first?.records.map((record) => record.body)).toEqual(['a', 'b']);

    await log.ack('search', first!.batchId);
    const second = await log.lease('search', 2);
    expect(second?.records.map((record) => record.body)).toEqual(['c', 'd']);
    expect(second?.batchId).not.toBe(first?.batchId);
  });

  it('hands different ranges to parallel workers and commits in order', async () => {
    const { log } = fixture({ leases: { maxParallelism: 2 } });
    await offsetsOf(log, ['a', 'b', 'c']);

    const first = await log.lease('search', 1);
    const second = await log.lease('search', 1);
    expect(first?.firstOffset).toBe(0);
    expect(second?.firstOffset).toBe(1);
    expect(await log.lease('search', 1)).toBeUndefined();

    // The later range finishing first must not commit past the earlier one.
    await log.ack('search', second!.batchId);
    expect(await log.cursor('search')).toBeUndefined();

    await log.ack('search', first!.batchId);
    expect(await log.cursor('search')).toBe(2);
  });

  it('redelivers a nacked range under a fresh batch id', async () => {
    const { log } = fixture({ leases: {} });
    await offsetsOf(log, ['a', 'b']);

    const first = await log.lease('search', 1);
    await log.nack('search', first!.batchId);
    const retry = await log.lease('search', 1);
    expect(retry).toMatchObject({ firstOffset: 0, attempt: 2 });
    expect(retry?.batchId).not.toBe(first?.batchId);
    expect(retry?.records.map((record) => record.body)).toEqual(['a']);
  });

  it('reclaims a range whose lease expired', async () => {
    const { log } = fixture({ leases: { leaseMs: 1_000 } });
    await offsetsOf(log, ['a']);

    const held = await log.lease('search', 1);
    expect(await log.lease('search', 1)).toBeUndefined();

    vi.advanceTimersByTime(1_001);
    const stolen = await log.lease('search', 1);
    expect(stolen).toMatchObject({ firstOffset: 0, attempt: 2 });

    // The original holder was fenced, so its ack cannot commit the range.
    await expect(log.ack('search', held!.batchId)).rejects.toThrow(
      LogLeaseError
    );
    await log.ack('search', stolen!.batchId);
    expect(await log.cursor('search')).toBe(1);
  });

  it('drops trimmed offsets from a range awaiting redelivery instead of wedging the consumer', async () => {
    const { log } = fixture({
      retention: { maxRecords: 3 },
      leases: { leaseMs: 1_000, maxParallelism: 2 },
    });
    await offsetsOf(log, ['a', 'b', 'c', 'd']);
    const whole = await log.lease('search', 2);
    const straddling = await log.lease('search', 2);
    expect(whole).toMatchObject({ firstOffset: 0, lastOffset: 1 });
    expect(straddling).toMatchObject({ firstOffset: 2, lastOffset: 3 });
    await log.nack('search', whole!.batchId);
    await log.nack('search', straddling!.batchId);

    // Retention trims 0..2 before either range is redelivered.
    await offsetsOf(log, ['e', 'f']);
    await log.trim();
    expect(await log.bounds()).toMatchObject({ oldestOffset: 3 });

    // Each lost range is reported once, then the consumer moves on.
    await expect(log.lease('search')).rejects.toThrow(LogTruncatedError);
    await expect(log.lease('search')).rejects.toThrow(LogTruncatedError);
    const retained = await log.lease('search');
    expect(retained).toMatchObject({
      firstOffset: 3,
      lastOffset: 3,
      attempt: 2,
    });
    expect(retained!.records.map((record) => record.body)).toEqual(['d']);
    await log.ack('search', retained!.batchId);
    const rest = await log.lease('search');
    expect(rest!.records.map((record) => record.body)).toEqual(['e', 'f']);
    await log.ack('search', rest!.batchId);
    expect(await log.cursor('search')).toBe(6);
  });

  it('moves the cursor past offsets trimmed before they were ever leased', async () => {
    const { log } = fixture({ retention: { maxRecords: 2 }, leases: {} });
    const first = await (async () => {
      await offsetsOf(log, ['a']);
      return log.lease('search');
    })();
    await log.ack('search', first!.batchId);
    expect(await log.cursor('search')).toBe(1);

    await offsetsOf(log, ['b', 'c', 'd', 'e']);
    await log.trim();
    expect(await log.bounds()).toMatchObject({ oldestOffset: 3 });

    const next = await log.lease('search');
    expect(next).toMatchObject({ firstOffset: 3, lastOffset: 4 });
    await log.ack('search', next!.batchId);
    expect(await log.cursor('search')).toBe(5);
  });

  it('redelivers a whole range that retention flushed partly to cold storage', async () => {
    const segments = new Map<string, LogRecord<string>[]>();
    const cold: LogColdStorage<string> = {
      write: async (segment) => {
        const locator = `s${segments.size}`;
        segments.set(locator, segment.records);
        return locator;
      },
      read: async (locator) => segments.get(locator),
    };
    const { log } = fixture({
      cold,
      retention: { maxRecords: 3 },
      leases: { leaseMs: 1_000 },
    });
    await offsetsOf(log, ['a', 'b', 'c', 'd']);
    const first = await log.lease('search', 4);
    await log.nack('search', first!.batchId);

    // Two flushes split the range over two segments and the hot window.
    await offsetsOf(log, ['e']);
    await log.trim();
    await offsetsOf(log, ['f']);
    await log.trim();
    expect(await log.bounds()).toMatchObject({ oldestOffset: 0, hotOffset: 3 });

    const again = await log.lease('search');
    expect(again).toMatchObject({ firstOffset: 0, lastOffset: 3, attempt: 2 });
    expect(again!.records.map((record) => record.body)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('advances the cursor over an acked range that retention partly trimmed', async () => {
    const { log } = fixture({ retention: { maxRecords: 3 }, leases: {} });
    await offsetsOf(log, ['a', 'b', 'c', 'd']);
    const straddling = await log.lease('search', 3);
    expect(straddling).toMatchObject({ firstOffset: 0, lastOffset: 2 });

    // Retention trims 0..1 while the range is held; the holder still acks it.
    await offsetsOf(log, ['e']);
    await log.trim();
    expect(await log.bounds()).toMatchObject({ oldestOffset: 2 });
    await log.ack('search', straddling!.batchId);
    expect(await log.cursor('search')).toBe(3);

    const rest = await log.lease('search');
    expect(rest).toMatchObject({ firstOffset: 3, lastOffset: 4 });
    await log.ack('search', rest!.batchId);
    expect(await log.cursor('search')).toBe(5);
  });

  it('advances the cursor over every range acked behind a late one', async () => {
    const { log } = fixture({
      maxBatchSize: 2,
      leases: { maxParallelism: 8, leaseMs: 1_000 },
    });
    for (const body of ['a', 'b', 'c', 'd', 'e', 'f']) {
      // eslint-disable-next-line no-await-in-loop
      await offsetsOf(log, [body]);
    }
    const leases = [];
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      leases.push(await log.lease('search', 1));
    }
    // Every range but the first is acked while the first is still out.
    for (const lease of leases.slice(1)) {
      // eslint-disable-next-line no-await-in-loop
      await log.ack('search', lease!.batchId);
    }
    expect(await log.cursor('search')).toBeUndefined();
    await log.ack('search', leases[0]!.batchId);
    expect(await log.cursor('search')).toBe(6);
  });

  it('rejects double settlement of one batch', async () => {
    const { log } = fixture({ leases: {} });
    await offsetsOf(log, ['a']);
    const lease = await log.lease('search');
    await log.ack('search', lease!.batchId);
    await expect(log.ack('search', lease!.batchId)).rejects.toThrow(
      LogLeaseError
    );
    await expect(log.nack('search', lease!.batchId)).rejects.toThrow(
      LogLeaseError
    );
  });

  it('keeps consumers independent', async () => {
    const { log } = fixture({ leases: {} });
    await offsetsOf(log, ['a', 'b']);

    const search = await log.lease('search', 1);
    const billing = await log.lease('billing', 1);
    expect(search?.firstOffset).toBe(0);
    expect(billing?.firstOffset).toBe(0);

    await log.ack('search', search!.batchId);
    expect(await log.cursors()).toEqual({ search: 1 });
  });

  it('blocks on a poison range without somewhere to send it', async () => {
    const { log } = fixture({ leases: { maxAttempts: 1 } });
    await offsetsOf(log, ['a', 'b']);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const lease = await log.lease('search', 1);
      expect(lease?.firstOffset).toBe(0);
      // eslint-disable-next-line no-await-in-loop
      await log.nack('search', lease!.batchId);
    }
    expect(await log.cursor('search')).toBeUndefined();
  });

  it('skips a poison range once it has somewhere to go', async () => {
    const poisoned: number[] = [];
    const { log } = fixture({
      leases: {
        maxAttempts: 2,
        onPoison: async (lease) => {
          poisoned.push(lease.firstOffset);
        },
      },
    });
    await offsetsOf(log, ['a', 'b']);

    const first = await log.lease('search', 1);
    await log.nack('search', first!.batchId);
    const second = await log.lease('search', 1);
    await log.nack('search', second!.batchId);

    // The third claim exhausts the budget, so the range is skipped.
    expect(await log.lease('search', 1)).toBeUndefined();
    expect(poisoned).toEqual([0]);

    const next = await log.lease('search', 1);
    expect(next?.firstOffset).toBe(1);
    await log.ack('search', next!.batchId);
    // Committing runs over the skipped range as well as the acked one.
    expect(await log.cursor('search')).toBe(2);
  });

  it('moves the cursor past a poison range even when it is the last one', async () => {
    const { log } = fixture({
      leases: { maxAttempts: 1, onPoison: async () => undefined },
    });
    await offsetsOf(log, ['a']);
    const first = await log.lease('search');
    await log.nack('search', first!.batchId);
    expect(await log.lease('search')).toBeUndefined();
    // Nothing else will be acked, so skipping must commit on its own.
    expect(await log.cursor('search')).toBe(1);
  });

  it('rehydrates a leased range that retention already flushed', async () => {
    const cold = coldStore();
    const { log } = fixture({
      retention: { maxRecords: 1 },
      cold,
      leases: {},
    });
    await offsetsOf(log, ['a', 'b']);

    const lease = await log.lease('search', 1);
    await log.nack('search', lease!.batchId);
    // Retention moves the leased offset to cold storage mid-flight.
    await log.trim();

    const retry = await log.lease('search', 1);
    expect(retry?.records.map((record) => record.body)).toEqual(['a']);
  });

  it('refuses lease calls when leases are not enabled', async () => {
    const { log } = fixture();
    await expect(log.lease('search')).rejects.toThrow(/leases option/);
  });

  it('reports backlog from the furthest-behind consumer', async () => {
    const { log } = fixture();
    await offsetsOf(log, ['a', 'b', 'c']);
    expect((await log.load()).outbound.pendingDeliveries).toBe(0);

    await log.commit('search', 3);
    await log.commit('billing', 1);
    expect((await log.load()).outbound.pendingDeliveries).toBe(2);

    await log.commit('billing', 3);
    expect((await log.load()).outbound.pendingDeliveries).toBe(0);
  });

  it('trims in batches larger than one page', async () => {
    const { log } = fixture({
      maxBatchSize: 2,
      retention: { maxRecords: 1 },
    });
    await offsetsOf(log, ['a', 'b']);
    await offsetsOf(log, ['c', 'd']);
    await offsetsOf(log, ['e']);
    expect(await log.trim()).toBe(4);
    expect(await log.bounds()).toEqual({
      oldestOffset: 4,
      hotOffset: 4,
      nextOffset: 5,
    });
  });
});

describe('log channels', () => {
  it.each(['default', 'library'])(
    'does not reserve %s when a migration fails',
    (channel) => {
      const storage = new FakeStorage();
      const context = contextFor(storage);
      vi.spyOn(storage, 'transactionSync').mockImplementationOnce(() => {
        throw new Error('migration unavailable');
      });
      const config = { context, channel };
      expect(() => new DurabilityLog(config)).toThrow('migration unavailable');
      expect(() => new DurabilityLog(config)).not.toThrow();
      expect(() => new DurabilityLog(config)).toThrow('already attached');
    }
  );

  it('accepts legacy cold segments without channel metadata', async () => {
    const segment: LogSegment<string> = {
      firstOffset: 0,
      lastOffset: 0,
      records: [],
    };
    const cold: LogColdStorage<string> = {
      write: async ({ channel = 'default', firstOffset }) =>
        JSON.stringify([channel, firstOffset]),
      read: async () => [],
    };
    await expect(cold.write(segment)).resolves.toBe('["default",0]');
  });

  const beforeChannels = 'durability_0007_create_log';
  const leasesBeforeChannels = 'durability_0008_create_log_leases';

  const append = async (
    log: DurabilityLog<string>,
    records: { body: string; deduplicationKey?: string }[]
  ): Promise<number[]> => {
    const result = await log.append(records);
    if (!result.success) {
      throw new Error(`append rejected: ${result.error.message}`);
    }
    return result.value;
  };

  /** One bucket shared by every channel, keyed by channel as the README asks. */
  const sharedCold = () => {
    const segments = new Map<string, LogRecord<string>[]>();
    const written: LogSegment<string>[] = [];
    const cold: LogColdStorage<string> = {
      write: async (segment) => {
        written.push(segment);
        const locator = JSON.stringify([segment.channel, segment.firstOffset]);
        if (segments.has(locator)) {
          throw new Error(`segment ${locator} already exists`);
        }
        segments.set(locator, segment.records);
        return locator;
      },
      read: async (locator) => segments.get(locator),
    };
    return { cold, segments, written };
  };

  it('allows one log per channel on a scheduler', () => {
    const context = contextFor(new FakeStorage());
    new DurabilityLog({ context });
    new DurabilityLog({ context, channel: 'library' });

    expect(() => new DurabilityLog({ context })).toThrow(
      'DurabilityLog for channel "default" is already attached to this scheduler'
    );
    expect(() => new DurabilityLog({ context, channel: 'library' })).toThrow(
      'DurabilityLog for channel "library" is already attached to this scheduler'
    );
    expect(() => new DurabilityLog({ context, channel: '' })).toThrow(
      'DurabilityLog channel must be a non-empty string'
    );
  });

  it('counts offsets and deduplicates per channel', async () => {
    const context = contextFor(new FakeStorage());
    const app = new DurabilityLog<string>({ context });
    const library = new DurabilityLog<string>({ context, channel: 'library' });

    expect(
      await append(app, [{ body: 'app-a', deduplicationKey: 'k' }])
    ).toEqual([0]);
    expect(
      await append(library, [{ body: 'library-a', deduplicationKey: 'k' }])
    ).toEqual([0]);
    expect(await append(app, [{ body: 'app-b' }, { body: 'app-c' }])).toEqual([
      1, 2,
    ]);
    expect(
      await append(library, [
        { body: 'ignored', deduplicationKey: 'k' },
        { body: 'library-b' },
      ])
    ).toEqual([0, 1]);

    expect((await app.read({ from: 0 })).records.map((r) => r.body)).toEqual([
      'app-a',
      'app-b',
      'app-c',
    ]);
    expect(
      (await library.read({ from: 0 })).records.map((r) => r.body)
    ).toEqual(['library-a', 'library-b']);
    expect(await library.bounds()).toEqual({
      oldestOffset: 0,
      hotOffset: 0,
      nextOffset: 2,
    });

    await app.commit('search', 3);
    await library.commit('search', 1);
    await library.commit('audit', 0);
    expect(await app.cursors()).toEqual({ search: 3 });
    expect(await library.cursors()).toEqual({ search: 1, audit: 0 });
    expect((await app.load()).outbound.pendingDeliveries).toBe(0);
    expect((await library.load()).outbound.pendingDeliveries).toBe(2);
  });

  it('starts a new channel at offset zero without writing on construction', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    const app = new DurabilityLog<string>({ context });
    await append(app, [{ body: 'a' }]);
    const library = new DurabilityLog<string>({ context, channel: 'library' });

    expect(await library.bounds()).toEqual({
      oldestOffset: 0,
      hotOffset: 0,
      nextOffset: 0,
    });
    expect(await library.read({ from: 0 })).toMatchObject({
      records: [],
      nextOffset: 0,
    });
    expect(
      storage.sql
        .exec('SELECT channel FROM durability_log_seq ORDER BY channel')
        .toArray()
    ).toEqual([{ channel: 'default' }]);
  });

  it('trims, flushes, and forgets one channel without touching another', async () => {
    const context = contextFor(new FakeStorage());
    const { cold, written } = sharedCold();
    const app = new DurabilityLog<string>({
      context,
      retention: { maxRecords: 1 },
      cold,
    });
    const library = new DurabilityLog<string>({
      context,
      channel: 'library',
      retention: { maxRecords: 2 },
      cold,
    });
    await append(app, [
      { body: 'app-a' },
      { body: 'app-b' },
      { body: 'app-c' },
    ]);
    await append(library, [
      { body: 'library-a' },
      { body: 'library-b' },
      { body: 'library-c' },
    ]);

    expect(await app.trim()).toBe(2);
    expect(await library.bounds()).toEqual({
      oldestOffset: 0,
      hotOffset: 0,
      nextOffset: 3,
    });
    expect(await library.trim()).toBe(1);
    expect(
      written.map(({ channel, firstOffset, lastOffset }) => ({
        channel,
        firstOffset,
        lastOffset,
      }))
    ).toEqual([
      {
        channel: 'default',
        firstOffset: 0,
        lastOffset: 1,
      },
      {
        channel: 'library',
        firstOffset: 0,
        lastOffset: 0,
      },
    ]);

    // Both channels flushed offset 0; each rehydrates its own.
    expect((await app.read({ from: 0 })).records.map((r) => r.body)).toEqual([
      'app-a',
      'app-b',
    ]);
    expect(
      (await library.read({ from: 0, limit: 1 })).records.map((r) => r.body)
    ).toEqual(['library-a']);

    expect(await library.forgetColdBefore(1)).toBe(1);
    await expect(library.read({ from: 0 })).rejects.toThrow(LogTruncatedError);
    expect((await app.read({ from: 0 })).records).toHaveLength(2);
    expect(await app.bounds()).toEqual({
      oldestOffset: 0,
      hotOffset: 2,
      nextOffset: 3,
    });
  });

  it('keeps byte budgets separate per channel', async () => {
    const context = contextFor(new FakeStorage());
    const app = new DurabilityLog<string>({
      context,
      retention: { maxBytes: 200 },
    });
    const library = new DurabilityLog<string>({ context, channel: 'library' });
    await append(library, [{ body: 'x'.repeat(300) }]);
    await append(app, [{ body: 'aaa' }]);

    expect(await app.trim()).toBe(0);
    expect((await library.bounds()).hotOffset).toBe(0);
  });

  it('settles, reclaims, and allocates leases only within their channel', async () => {
    const context = contextFor(new FakeStorage());
    const app = new DurabilityLog<string>({
      context,
      leases: { leaseMs: 1_000 },
    });
    const library = new DurabilityLog<string>({
      context,
      channel: 'library',
      leases: { leaseMs: 1_000 },
    });
    await append(app, [{ body: 'app-a' }, { body: 'app-b' }]);
    await append(library, [{ body: 'library-a' }, { body: 'library-b' }]);
    const uuid = vi.spyOn(crypto, 'randomUUID');
    uuid.mockReturnValue('0-0-0-0-same');

    const appLease = await app.lease('worker', 1);
    const libraryLease = await library.lease('worker', 1);
    expect(appLease).toMatchObject({ batchId: '0-0-0-0-same', firstOffset: 0 });
    expect(libraryLease).toMatchObject({
      batchId: '0-0-0-0-same',
      firstOffset: 0,
    });
    expect(libraryLease?.records.map((r) => r.body)).toEqual(['library-a']);

    await app.ack('worker', '0-0-0-0-same');
    expect(await app.cursor('worker')).toBe(1);
    expect(await library.cursor('worker')).toBeUndefined();
    expect(await library.leases('worker')).toMatchObject([
      { batch_id: '0-0-0-0-same', state: 'active' },
    ]);
    await expect(app.ack('worker', '0-0-0-0-same')).rejects.toThrow(
      LogLeaseError
    );

    // Expiry reclaims only the channel's own range.
    vi.advanceTimersByTime(1_001);
    uuid.mockReturnValue('0-0-0-0-next');
    expect(await app.lease('worker', 1)).toMatchObject({
      firstOffset: 1,
      attempt: 1,
    });
    expect(await library.lease('worker', 1)).toMatchObject({
      batchId: '0-0-0-0-next',
      firstOffset: 0,
      attempt: 2,
    });
    await library.nack('worker', '0-0-0-0-next');
    expect(await app.leases('worker')).toMatchObject([
      { first_offset: 1, state: 'active' },
    ]);
  });

  it('keeps legacy records, cursors, locators, and pending leases on the default channel', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    DurabilityLog.migrate(context, beforeChannels);
    migrateCapability(
      storage,
      'logLeases',
      durabilityLogLeaseMigrations,
      leasesBeforeChannels
    );
    for (const [offset, body] of [
      [1, 'b'],
      [2, 'c'],
    ] as const) {
      storage.sql.exec(
        `INSERT INTO durability_log_records
         ("offset", dedup_key, payload, bytes, appended_at)
         VALUES (?, ?, ?, 1, 0)`,
        offset,
        `["library",${offset}]`,
        serialize(body)
      );
    }
    storage.sql.exec(
      'UPDATE durability_log_seq SET next_offset = 3, total_bytes = 2'
    );
    storage.sql.exec(
      `INSERT INTO durability_log_segments VALUES (0, 0, 'r2://legacy/0', 1, 0)`
    );
    storage.sql.exec(
      `INSERT INTO durability_log_cursors VALUES ('audit', 1, 0), ('worker', 1, 0)`
    );
    storage.sql.exec(
      `INSERT INTO durability_log_leases
       VALUES ('legacy-batch', 'worker', 1, 1, 'pending', 1, 0, 0)`
    );
    storage.sql.exec(
      `INSERT INTO durability_log_allocations VALUES ('worker', 2)`
    );

    const read = vi.fn(async (locator: string) =>
      locator === 'r2://legacy/0'
        ? [
            {
              offset: 0,
              deduplicationKey: 'a',
              body: 'a',
              appendedAt: 0,
            },
          ]
        : undefined
    );
    const log = new DurabilityLog<string>({
      context,
      leases: {},
      cold: {
        write: async () => 'unused',
        read,
      },
    });
    new DurabilityLog<string>({ context, channel: 'library' });

    expect(await log.bounds()).toEqual({
      oldestOffset: 0,
      hotOffset: 1,
      nextOffset: 3,
    });
    expect((await log.read({ from: 0 })).records.map((r) => r.body)).toEqual([
      'a',
    ]);
    expect(read).toHaveBeenCalledWith('r2://legacy/0');
    expect(await log.cursors()).toEqual({ audit: 1, worker: 1 });
    expect(
      await append(log, [
        { body: 'repeat', deduplicationKey: '["library",2]' },
        { body: 'd' },
      ])
    ).toEqual([2, 3]);

    const redelivered = await log.lease('worker');
    expect(redelivered).toMatchObject({
      firstOffset: 1,
      lastOffset: 1,
      attempt: 2,
      records: [{ body: 'b' }],
    });
    await log.ack('worker', redelivered!.batchId);
    expect(await log.cursor('worker')).toBe(2);
    expect(await log.lease('worker')).toMatchObject({
      firstOffset: 2,
      lastOffset: 3,
    });
  });

  it('refuses a downgrade that would discard non-default channels', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    const app = new DurabilityLog<string>({ context, leases: {} });
    const library = new DurabilityLog<string>({
      context,
      channel: 'library',
      leases: {},
    });
    await append(app, [{ body: 'app' }]);
    await append(library, [{ body: 'library' }]);
    await library.lease('worker');

    expect(() => DurabilityLog.migrate(context, beforeChannels)).toThrow(
      /cannot_downgrade_nondefault_channels/
    );
    expect(() =>
      migrateCapability(
        storage,
        'logLeases',
        durabilityLogLeaseMigrations,
        leasesBeforeChannels
      )
    ).toThrow(/cannot_downgrade_nondefault_channels/);
    expect(
      storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE name LIKE 'durability_log%guard'"
        )
        .toArray()
    ).toEqual([]);
    expect((await library.read({ from: 0 })).records).toHaveLength(1);
    expect(await library.leases('worker')).toHaveLength(1);
  });

  it('downgrades default-only data to the legacy shape', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    const app = new DurabilityLog<string>({ context, leases: {} });
    await append(app, [{ body: 'a' }, { body: 'b' }]);
    await app.commit('audit', 1);
    await app.lease('worker', 1);

    expect(
      migrateCapability(
        storage,
        'logLeases',
        durabilityLogLeaseMigrations,
        leasesBeforeChannels
      ).rolledBack
    ).toEqual(['durability_0024_log_lease_channels']);
    expect(DurabilityLog.migrate(context, beforeChannels).rolledBack).toEqual([
      'durability_0019_log_channels',
    ]);
    expect(
      storage.sql.exec('SELECT * FROM durability_log_seq').toArray()
    ).toEqual([
      {
        id: 1,
        next_offset: 2,
        total_bytes: expect.any(Number),
      },
    ]);
    expect(
      storage.sql
        .exec('SELECT "offset", dedup_key FROM durability_log_records')
        .toArray()
    ).toHaveLength(2);
    expect(
      storage.sql.exec('SELECT * FROM durability_log_cursors').toArray()
    ).toMatchObject([{ consumer: 'audit', offset: 1 }]);
    expect(
      storage.sql
        .exec('SELECT batch_id, consumer FROM durability_log_leases')
        .toArray()
    ).toMatchObject([{ consumer: 'worker' }]);
  });
});
