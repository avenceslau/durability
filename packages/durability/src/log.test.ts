import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DurabilityLog,
  LogLeaseError,
  LogTruncatedError,
  maxLogBytes,
} from './index';
import type { LogColdStorage, LogRecord } from './log';
import { FakeKvStorage, FakeStorage } from './test-fakes';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

for (const backend of ['sqlite', 'kv'] as const) {
  describe(`log ${backend}`, () => {
    const fixture = (
      options: Partial<
        Pick<
          ConstructorParameters<typeof DurabilityLog<string>>[0],
          'retention' | 'cold' | 'maxBatchSize' | 'leases'
        >
      > = {}
    ) => {
      const storage =
        backend === 'sqlite' ? new FakeStorage() : new FakeKvStorage();
      const log = new DurabilityLog<string>({
        context: { storage: storage as unknown as DurableObjectStorage },
        storageBackend: backend,
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
      expect(page.records.map((record) => record.body)).toEqual([
        'a',
        'b',
        'c',
      ]);
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
      expect(() =>
        fixture({ retention: { maxBytes: maxLogBytes + 1 } })
      ).toThrow(/maxBytes/);
    });

    it('handles more flushed segments than one storage batch', async () => {
      const cold = coldStore();
      // One record per segment, well past the 128-key batch limits a backend
      // may hit when indexing or expiring segments.
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
}
