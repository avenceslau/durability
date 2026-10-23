import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurabilityTracker } from './experimental';
import {
  Durability,
  DurabilityAlarms,
  DurableMemoSerializationError,
  maxMemoBytes,
  maxMemosPerRecord,
  NonRetryableError,
  type DurableCall,
} from './index';
import { contextFor, FakeStorage } from './test-fakes';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const savedMemos = (storage: FakeStorage) =>
  storage.sql
    .exec<{ owner: string; key: string; memo_key: string }>(
      'SELECT owner, key, memo_key FROM durability_memos ORDER BY memo_key'
    )
    .toArray();

describe('memoize', () => {
  it('reuses finished results on retry and deletes them when the operation completes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const sent: string[] = [];
    let failing = true;
    const durability = new Durability({
      context: contextFor(storage),
      retries: { delay: () => 1_000 },
      handlers: {
        deliver: async ({ payload, memoize }: DurableCall<string[]>) => {
          const results = await Promise.allSettled(
            payload.map((target) =>
              memoize(`send:${target}`, async () => {
                if (target === 'b' && failing) {
                  throw new Error('b is down');
                }
                sent.push(target);
                return `sent:${target}`;
              })
            )
          );
          const failure = results.find(
            (result) => result.status === 'rejected'
          );
          if (failure) {
            throw failure.reason;
          }
          return results.map((result) =>
            result.status === 'fulfilled' ? result.value : null
          );
        },
      },
    });

    await durability.deliver({ id: 'batch', payload: ['a', 'b', 'c'] });
    await vi.waitFor(async () => {
      await expect(
        durability.deliver.getResult('batch')
      ).resolves.toMatchObject({ status: 'pending', attempt: 1 });
    });
    expect(sent).toEqual(['a', 'c']);
    expect(savedMemos(storage)).toEqual([
      { owner: 'durability_calls', key: 'batch', memo_key: 'send:a' },
      { owner: 'durability_calls', key: 'batch', memo_key: 'send:c' },
    ]);

    failing = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(async () => {
      await expect(durability.deliver.getResult('batch')).resolves.toEqual({
        status: 'completed',
        result: ['sent:a', 'sent:b', 'sent:c'],
      });
    });
    expect(sent).toEqual(['a', 'c', 'b']);
    expect(savedMemos(storage)).toEqual([]);
  });

  it('retries a completion whose memo cleanup fails instead of orphaning the memos', async () => {
    const storage = new FakeStorage();
    const work = vi.fn(() => 'done');
    const durability = new Durability({
      context: contextFor(storage),
      retries: { delay: () => 0 },
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => memoize('work', work),
      },
    });
    const exec = storage.sql.exec.bind(storage.sql);
    let failCleanup = true;
    vi.spyOn(storage.sql, 'exec').mockImplementation((query, ...bindings) => {
      if (
        failCleanup &&
        query.includes(
          'DELETE FROM durability_memos WHERE owner = ? AND key = ?'
        )
      ) {
        failCleanup = false;
        throw new Error('cleanup failed');
      }
      return exec(query, ...bindings);
    });

    await durability.work({ id: 'cleanup', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('cleanup')).resolves.toEqual({
        status: 'completed',
        result: 'done',
      });
    });
    expect(failCleanup).toBe(false);
    expect(work).toHaveBeenCalledTimes(1);
    expect(savedMemos(storage)).toEqual([]);
  });

  it('returns the first result for a key used again in the same attempt', async () => {
    const storage = new FakeStorage();
    const first = vi.fn(() => 1);
    const second = vi.fn(() => 2);
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => [
          await memoize('value', first),
          await memoize('value', second),
        ],
      },
    });

    await durability.work({ id: 'repeat', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('repeat')).resolves.toEqual({
        status: 'completed',
        result: [1, 1],
      });
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('rejects a key that is already running instead of waiting on it', async () => {
    const storage = new FakeStorage();
    const callback = vi.fn(async () => 'once');
    const durability = new Durability({
      context: contextFor(storage),
      retries: { maxAttempts: 1 },
      handlers: {
        concurrent: async ({ memoize }: DurableCall<null>) => {
          const results = await Promise.allSettled([
            memoize('shared', callback),
            memoize('shared', callback),
          ]);
          return results.map((result) => {
            if (result.status === 'fulfilled') {
              return result.value;
            }
            return result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          });
        },
        reentrant: async ({ memoize }: DurableCall<null>) =>
          memoize('self', () => memoize('self', () => 'never')),
      },
    });

    await durability.concurrent({ id: 'concurrent', payload: null });
    await durability.reentrant({ id: 'reentrant', payload: null });
    await vi.waitFor(async () => {
      await expect(
        durability.concurrent.getResult('concurrent')
      ).resolves.toEqual({
        status: 'completed',
        result: [
          'once',
          'Memoized key "shared" is already running; await the first call instead',
        ],
      });
      await expect(
        durability.reentrant.getResult('reentrant')
      ).resolves.toEqual({
        status: 'failed',
        attempt: 1,
        error: {
          name: 'Error',
          message:
            'Memoized key "self" is already running; await the first call instead',
        },
      });
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('keeps a key running while its result serializes', async () => {
    const storage = new FakeStorage();
    let runs = 0;
    let second: Promise<unknown> | undefined;
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => {
          const callback = () => {
            runs += 1;
            return {
              get value() {
                second ??= memoize('shared', callback);
                return 1;
              },
            };
          };
          const first = await memoize('shared', callback);
          const outcome = await Promise.allSettled([second]);
          return {
            runs,
            first,
            second:
              outcome[0]?.status === 'rejected' &&
              outcome[0].reason instanceof Error
                ? outcome[0].reason.message
                : outcome[0]?.status,
          };
        },
      },
    });

    await durability.work({ id: 'getter', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('getter')).resolves.toEqual({
        status: 'completed',
        result: {
          runs: 1,
          first: { value: 1 },
          second:
            'Memoized key "shared" is already running; await the first call instead',
        },
      });
    });
  });

  it('returns a saved result to every concurrent caller', async () => {
    const storage = new FakeStorage();
    const callback = vi.fn(() => 'saved');
    let attempt = 0;
    const durability = new Durability({
      context: contextFor(storage),
      retries: { delay: () => 0 },
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => {
          attempt += 1;
          if (attempt === 1) {
            await memoize('shared', callback);
            throw new Error('retry');
          }
          return Promise.all([
            memoize('shared', callback),
            memoize('shared', callback),
          ]);
        },
      },
    });

    await durability.work({ id: 'cached', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('cached')).resolves.toEqual({
        status: 'completed',
        result: ['saved', 'saved'],
      });
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('runs a failed key again when it is called again', async () => {
    const storage = new FakeStorage();
    const callback = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw new Error('first try');
      })
      .mockReturnValue('second try');
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => {
          await memoize('flaky', callback).catch(() => undefined);
          return memoize('flaky', callback);
        },
      },
    });

    await durability.work({ id: 'again', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('again')).resolves.toEqual({
        status: 'completed',
        result: 'second try',
      });
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('keeps nested keys independent of whether their parent replays', async () => {
    const storage = new FakeStorage();
    const sent: string[] = [];
    let attempt = 0;
    const durability = new Durability({
      context: contextFor(storage),
      retries: { delay: () => 0 },
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => {
          attempt += 1;
          await memoize('outer', () =>
            memoize('send:A', () => {
              sent.push('A');
              return 'A';
            })
          );
          if (attempt === 1) {
            throw new Error('transient');
          }
          return memoize('send:B', () => {
            sent.push('B');
            return 'B';
          });
        },
      },
    });

    await durability.work({ id: 'nested', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('nested')).resolves.toEqual({
        status: 'completed',
        result: 'B',
      });
    });
    expect(sent).toEqual(['A', 'B']);
  });

  it('fails the work when it memoizes more keys than the limit allows', async () => {
    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => {
          for (let index = 0; index <= maxMemosPerRecord; index += 1) {
            // eslint-disable-next-line no-await-in-loop
            await memoize(`key:${index}`, () => index);
          }
        },
      },
    });

    await durability.work({ id: 'many', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('many')).resolves.toEqual({
        status: 'failed',
        attempt: 1,
        error: {
          name: 'DurableMemoLimitError',
          message: `Memoizing "key:${maxMemosPerRecord}" would exceed ${maxMemosPerRecord} keys`,
        },
      });
    });
    expect(savedMemos(storage)).toEqual([]);
  });

  it('fails the work when a memoized result is larger than the limit', async () => {
    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        work: async ({ memoize }: DurableCall<null>) =>
          memoize('large', () => 'x'.repeat(maxMemoBytes)),
      },
    });

    await durability.work({ id: 'large', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('large')).resolves.toMatchObject({
        status: 'failed',
        attempt: 1,
        error: { name: 'DurableMemoLimitError' },
      });
    });
    expect(savedMemos(storage)).toEqual([]);
  });

  it('lists the memoized keys of pending work in the tracker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      retries: { delay: () => 60_000 },
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => {
          await memoize('fetch', () => 1);
          await memoize('transform', () => 2);
          throw new Error('upload failed');
        },
      },
    });
    const tracker = new DurabilityTracker({ sources: { jobs: durability } });

    await durability.work({ id: 'job', payload: null });
    await vi.waitFor(() => expect(savedMemos(storage)).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(0);

    await expect(tracker.records({ limit: 10 })).resolves.toMatchObject({
      records: [
        {
          id: 'job',
          state: { status: 'pending', memoized: ['fetch', 'transform'] },
        },
      ],
    });
  });

  it('returns the persisted shape on the first run too', async () => {
    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => {
          const value = await memoize('optional', () => ({
            kept: 1,
            dropped: undefined,
          }));
          return Object.keys(value);
        },
      },
    });

    await durability.work({ id: 'shape', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('shape')).resolves.toEqual({
        status: 'completed',
        result: ['kept'],
      });
    });
  });

  it('deletes memos when an operation fails terminally', async () => {
    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => {
          await memoize('first', () => 1);
          throw new NonRetryableError('stop');
        },
      },
    });

    await durability.work({ id: 'terminal', payload: null });
    await vi.waitFor(async () => {
      await expect(
        durability.work.getResult('terminal')
      ).resolves.toMatchObject({ status: 'failed' });
    });
    expect(savedMemos(storage)).toEqual([]);
  });

  it('fails an operation terminally when a memoized result cannot be persisted', async () => {
    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        work: async ({ memoize }: DurableCall<null>) =>
          memoize('bad', () => () => undefined),
      },
    });

    await durability.work({ id: 'unserializable', payload: null });
    await vi.waitFor(async () => {
      await expect(
        durability.work.getResult('unserializable')
      ).resolves.toEqual({
        status: 'failed',
        attempt: 1,
        error: {
          name: 'DurableMemoSerializationError',
          message: new DurableMemoSerializationError('bad').message,
        },
      });
    });
  });

  it('rejects empty keys', async () => {
    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => memoize('', () => 1),
      },
      retries: { maxAttempts: 1 },
    });

    await durability.work({ id: 'unnamed', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('unnamed')).resolves.toEqual({
        status: 'failed',
        attempt: 1,
        error: {
          name: 'TypeError',
          message: 'Memoize keys must be non-empty strings',
        },
      });
    });
  });

  it('removes the memos of purged operations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10);
    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      retries: { delay: () => 60_000 },
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => {
          await memoize('saved', () => 1);
          throw new Error('retry later');
        },
      },
    });

    await durability.work({ id: 'old', payload: null });
    await vi.waitFor(() => expect(savedMemos(storage)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(0);

    await expect(durability.purgeBefore(Date.now() + 1)).resolves.toBe(1);
    expect(savedMemos(storage)).toEqual([]);
  });

  it('deletes the memos of a reverted helper and keeps the other helper memos', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    const durability = new Durability({
      context,
      retries: { delay: () => 60_000 },
      handlers: {
        work: async ({ memoize }: DurableCall<null>) => {
          await memoize('saved', () => 1);
          throw new Error('retry later');
        },
      },
    });
    const alarms = new DurabilityAlarms({
      context,
      retries: { delay: () => 60_000 },
      handlers: {
        sync: async ({ memoize }) => {
          await memoize('saved', () => 1);
          throw new Error('retry later');
        },
      },
    });

    await durability.work({ id: 'op', payload: null });
    await alarms.sync(Date.now());
    await alarms.alarm();
    await vi.waitFor(() => expect(savedMemos(storage)).toHaveLength(2));

    Durability.migrate(context, null);
    expect(savedMemos(storage)).toEqual([
      { owner: 'durability_alarms', key: 'sync', memo_key: 'saved' },
    ]);
  });

  it('reuses finished results when a named alarm retries and deletes them on success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const expensive = vi.fn(async () => 'built');
    let failing = true;
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      retries: { delay: () => 1_000 },
      handlers: {
        report: async ({ memoize }) => {
          await memoize('build', expensive);
          if (failing) {
            throw new Error('upload failed');
          }
        },
      },
    });

    await alarms.report(Date.now());
    await vi.waitFor(() => expect(expensive).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(savedMemos(storage)).toEqual([
      { owner: 'durability_alarms', key: 'report', memo_key: 'build' },
    ]);

    failing = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(storage.alarmAt).toBeNull());
    expect(expensive).toHaveBeenCalledTimes(1);
    expect(savedMemos(storage)).toEqual([]);
  });

  it('starts a rescheduled alarm without the replaced occurrence memos', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    let finishPull: (() => void) | undefined;
    const pullRunning = new Promise<void>((resolve) => {
      finishPull = resolve;
    });
    const after = vi.fn(() => 'after');
    const outcomes: Array<PromiseSettledResult<unknown>> = [];
    let runs = 0;
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: {
        sync: async ({ memoize }) => {
          runs += 1;
          outcomes.push(
            ...(await Promise.allSettled([
              memoize('pull', async () => {
                if (runs === 1) {
                  await pullRunning;
                }
                return runs;
              }),
            ]))
          );
          if (runs === 1) {
            outcomes.push(
              ...(await Promise.allSettled([memoize('after', after)]))
            );
          }
        },
      },
    });

    await alarms.sync(Date.now());
    await vi.waitFor(() => expect(runs).toBe(1));
    await alarms.sync(Date.now() + 60_000);
    finishPull?.();
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));

    expect(outcomes).toMatchObject([
      {
        status: 'rejected',
        reason: {
          message: 'Memoized key "pull" belongs to a superseded attempt',
        },
      },
      {
        status: 'rejected',
        reason: {
          message: 'Memoized key "after" belongs to a superseded attempt',
        },
      },
    ]);
    expect(after).not.toHaveBeenCalled();
    expect(savedMemos(storage)).toEqual([]);
  });
});
