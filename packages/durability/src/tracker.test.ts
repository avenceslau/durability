import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  DurabilityTracker,
  type TrackedRecord,
  type TrackedSource,
} from './experimental';
import * as stable from './index';
import {
  Durability,
  DurabilityAlarms,
  DurabilityScheduler,
  NonRetryableError,
  type DurableCall,
} from './index';
import { contextFor, FakeStorage } from './test-fakes';

afterEach(() => {
  vi.restoreAllMocks();
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const scheduler = () =>
  new DurabilityScheduler({ context: contextFor(new FakeStorage()) });

describe('DurabilityTracker listing', () => {
  it('pages across sources and filters by status and name', async () => {
    const gate = deferred();
    const shared = scheduler();
    const durability = new Durability({
      scheduler: shared,
      handlers: {
        resize: async ({ payload }: DurableCall<{ size: number }>) => {
          await gate.promise;
          return payload.size;
        },
        done: async (_call: DurableCall<null>) => 'ok',
      },
    });
    const alarms = new DurabilityAlarms({
      scheduler: shared,
      handlers: { cleanup: async () => undefined },
    });
    const tracker = new DurabilityTracker({
      sources: { jobs: durability, alarms },
    });

    await durability.resize({ id: 'a', payload: { size: 1 } });
    await durability.resize({ id: 'b', payload: { size: 2 } });
    await durability.done({ id: 'c', payload: null });
    await alarms.cleanup(Date.now() + 60_000);
    await vi.waitFor(async () => {
      expect(await durability.done.getResult('c')).toMatchObject({
        status: 'completed',
      });
    });

    const first = await tracker.list({ limit: 2 });
    expect(first.items.map(({ source, id }) => [source, id])).toEqual([
      ['jobs', 'a'],
      ['jobs', 'b'],
    ]);
    const second = await tracker.list({ limit: 2, cursor: first.cursor });
    expect(second.items.map(({ source, id }) => [source, id])).toEqual([
      ['jobs', 'c'],
      ['alarms', 'cleanup'],
    ]);
    expect(second.cursor).toBeUndefined();

    const pending = await tracker.list({ source: 'jobs', status: 'pending' });
    expect(pending.items.map(({ id }) => id)).toEqual(['a', 'b']);
    const named = await tracker.list({ name: 'done' });
    expect(named.items).toMatchObject([
      {
        source: 'jobs',
        id: 'c',
        name: 'done',
        state: { status: 'completed' },
      },
    ]);
    await expect(named.items[0]?.get()).resolves.toEqual({
      status: 'completed',
      result: 'ok',
    });

    gate.resolve();
  });

  it('returns the same pages as plain records', async () => {
    const gate = deferred();
    const durability = new Durability({
      scheduler: scheduler(),
      handlers: {
        resize: async ({ payload }: DurableCall<{ size: number }>) => {
          await gate.promise;
          return payload.size;
        },
      },
    });
    const tracker = new DurabilityTracker({ sources: { jobs: durability } });
    for (const id of ['a', 'b', 'c']) {
      // eslint-disable-next-line no-await-in-loop
      await durability.resize({ id, payload: { size: 1 } });
    }

    const first = await tracker.records({ limit: 2 });
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(first.records).toMatchObject([
      { source: 'jobs', id: 'a', name: 'resize', state: { status: 'pending' } },
      { source: 'jobs', id: 'b', name: 'resize', state: { status: 'pending' } },
    ]);
    const second = await tracker.records({ limit: 2, cursor: first.cursor });
    expect(second).toEqual({
      records: [expect.objectContaining({ source: 'jobs', id: 'c' })],
    });

    gate.resolve();
  });

  it('follows cursors through status-filtered pages', async () => {
    const gate = deferred();
    const durability = new Durability({
      scheduler: scheduler(),
      handlers: {
        quick: async (_call: DurableCall<null>) => 'ok',
        slow: async (_call: DurableCall<null>) => gate.promise,
      },
    });
    const tracker = new DurabilityTracker({ sources: { jobs: durability } });
    for (const id of ['a', 'b', 'c', 'd']) {
      // eslint-disable-next-line no-await-in-loop
      await durability.quick({ id, payload: null });
    }
    await durability.slow({ id: 'e', payload: null });
    await vi.waitFor(async () => {
      expect(await durability.quick.getResult('d')).toMatchObject({
        status: 'completed',
      });
    });

    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await tracker.list({ status: 'pending', limit: 2, cursor });
      ids.push(...page.items.map(({ id }) => id));
      cursor = page.cursor;
    } while (cursor !== undefined);

    expect(ids).toEqual(['e']);
    gate.resolve();
  });

  it('waits for an operation to complete', async () => {
    const gate = deferred();
    const durability = new Durability({
      scheduler: scheduler(),
      handlers: {
        resize: async (_call: DurableCall<null>) => {
          await gate.promise;
          return 'resized';
        },
      },
    });
    const tracker = new DurabilityTracker({ sources: { jobs: durability } });
    await durability.resize({ id: 'job', payload: null });
    const handle = await tracker.get('jobs', 'job');

    const waiting = handle?.wait({ timeoutMs: 10_000 });
    gate.resolve();

    await expect(waiting).resolves.toEqual({
      status: 'completed',
      result: 'resized',
    });
  });
});

describe('DurabilityTracker', () => {
  const setup = (
    handler: (call: DurableCall<null>) => Promise<unknown>,
    options: { maxAttempts?: number } = {}
  ) => {
    const durability = new Durability({
      context: contextFor(new FakeStorage()),
      handlers: { work: handler },
      retries: {
        maxAttempts: options.maxAttempts ?? 1,
        delay: () => 60_000,
      },
    });
    const tracker = new DurabilityTracker({ sources: { jobs: durability } });
    return { durability, tracker };
  };

  it('returns a terminal failure as soon as it is persisted', async () => {
    const gate = deferred();
    const { durability, tracker } = setup(async () => {
      await gate.promise;
      throw new NonRetryableError('bad input');
    });
    await durability.work({ id: 'job', payload: null });
    const handle = await tracker.get('jobs', 'job');

    const waiting = handle?.wait({ timeoutMs: 10_000 });
    gate.resolve();

    await expect(waiting).resolves.toMatchObject({
      status: 'failed',
      attempt: 1,
      error: { name: 'NonRetryableError', message: 'bad input' },
    });
  });

  it('keeps waiting through a scheduled retry and returns pending on timeout', async () => {
    const gate = deferred();
    const { durability, tracker } = setup(
      async () => {
        await gate.promise;
        throw new Error('flaky');
      },
      { maxAttempts: 3 }
    );
    await durability.work({ id: 'job', payload: null });
    const handle = await tracker.get('jobs', 'job');

    const waiting = handle?.wait({ timeoutMs: 50 });
    gate.resolve();

    await expect(waiting).resolves.toMatchObject({
      status: 'pending',
      attempt: 1,
      lastError: 'flaky',
    });
  });

  it('settles every waiter from one completion', async () => {
    const gate = deferred();
    const { durability, tracker } = setup(async () => {
      await gate.promise;
      return 1;
    });
    await durability.work({ id: 'job', payload: null });
    const handle = await tracker.get('jobs', 'job');

    const waiters = [
      handle?.wait({ timeoutMs: 10_000 }),
      handle?.wait({ timeoutMs: 10_000 }),
    ];
    gate.resolve();

    await expect(Promise.all(waiters)).resolves.toEqual([
      { status: 'completed', result: 1 },
      { status: 'completed', result: 1 },
    ]);
  });

  it('returns not_found when the record is purged or its id reused', async () => {
    const gate = deferred();
    const { durability, tracker } = setup(async () => {
      await gate.promise;
      return 'old';
    });
    await durability.work({ id: 'job', payload: null });
    const handle = await tracker.get('jobs', 'job');

    const waiting = handle?.wait({ timeoutMs: 10_000 });
    await durability.purgeBefore(Number.MAX_SAFE_INTEGER);
    await expect(waiting).resolves.toEqual({ status: 'not_found' });

    await durability.work({ id: 'job', payload: null });
    await expect(handle?.get()).resolves.toEqual({ status: 'not_found' });
    gate.resolve();
  });

  it('returns immediately for timeoutMs 0 and rejects invalid timeouts', async () => {
    const gate = deferred();
    const { durability, tracker } = setup(async () => gate.promise);
    await durability.work({ id: 'job', payload: null });
    const handle = await tracker.get('jobs', 'job');

    await expect(handle?.wait({ timeoutMs: 0 })).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(handle?.wait({ timeoutMs: -1 })).rejects.toThrow(RangeError);
    await expect(handle?.wait({ timeoutMs: 1.5 })).rejects.toThrow(RangeError);
    gate.resolve();
  });

  it('validates limits and source keys', async () => {
    const { tracker } = setup(async () => undefined);

    await expect(tracker.list({ limit: 0 })).rejects.toThrow(
      'Too small: expected number to be >=1'
    );
    await expect(tracker.list({ limit: 101 })).rejects.toThrow(
      'Too big: expected number to be <=100'
    );
    await expect(
      // @ts-expect-error unknown source keys are rejected
      tracker.list({ source: 'missing' })
    ).rejects.toThrow('Unknown tracked source "missing"');
    await expect(tracker.get('jobs', 'missing')).resolves.toBeUndefined();
  });

  it('omits results, payloads, and error text from list output', async () => {
    const durability = new Durability({
      context: contextFor(new FakeStorage()),
      handlers: {
        done: async (_call: DurableCall<null>) => ({ secret: 'token-123' }),
        flaky: async (_call: DurableCall<null>) => {
          throw new NonRetryableError('sensitive detail');
        },
      },
      retries: { maxAttempts: 1, delay: () => 60_000 },
    });
    const tracker = new DurabilityTracker({ sources: { jobs: durability } });
    await durability.done({ id: 'ok', payload: null });
    await durability.flaky({ id: 'bad', payload: null });
    await vi.waitFor(async () => {
      expect(await durability.done.getResult('ok')).toMatchObject({
        status: 'completed',
      });
      expect(await durability.flaky.getResult('bad')).toMatchObject({
        status: 'failed',
      });
    });

    const { records } = await tracker.records({ source: 'jobs' });
    const completed = records.find(({ id }) => id === 'ok');
    const failed = records.find(({ id }) => id === 'bad');
    expect(completed?.state).toEqual({ status: 'completed' });
    expect(failed?.state).toEqual({
      status: 'failed',
      attempt: 1,
      error: { name: 'NonRetryableError' },
    });
    expect(JSON.stringify(records)).not.toContain('token-123');
    expect(JSON.stringify(records)).not.toContain('sensitive detail');

    const { items } = await tracker.list({ source: 'jobs' });
    const handle = items.find(({ id }) => id === 'ok');
    expect(handle?.state).toEqual({ status: 'completed' });
    await expect(handle?.get()).resolves.toEqual({
      status: 'completed',
      result: { secret: 'token-123' },
    });
  });

  it('reports a named alarm success even though success deletes it', async () => {
    const gate = deferred();
    const alarms = new DurabilityAlarms({
      context: contextFor(new FakeStorage()),
      handlers: { cleanup: async () => gate.promise },
    });
    const tracker = new DurabilityTracker({ sources: { alarms } });
    await alarms.cleanup(Date.now());
    const handle = await tracker.get('alarms', 'cleanup');

    const waiting = handle?.wait({ timeoutMs: 10_000 });
    gate.resolve();

    await expect(waiting).resolves.toEqual({
      status: 'completed',
      result: undefined,
    });
    await expect(handle?.get()).resolves.toEqual({ status: 'not_found' });
  });

  it('returns not_found when a named alarm occurrence is replaced', async () => {
    const alarms = new DurabilityAlarms({
      context: contextFor(new FakeStorage()),
      handlers: { cleanup: async () => undefined },
    });
    const tracker = new DurabilityTracker({ sources: { alarms } });
    await alarms.cleanup(Date.now() + 60_000);
    const handle = await tracker.get('alarms', 'cleanup');

    const waiting = handle?.wait({ timeoutMs: 10_000 });
    await alarms.cleanup(Date.now() + 120_000);

    await expect(waiting).resolves.toEqual({ status: 'not_found' });
  });

  it('reads custom sources and unsubscribes after settlement', async () => {
    type Approvals = { approval: { approvedBy: string } };
    let row: TrackedRecord<Approvals> = {
      id: 'order-1',
      name: 'approval',
      generation: 'order-1',
      createdAt: 1,
      state: { status: 'pending' },
    };
    const listeners = new Set<(settled?: TrackedRecord<Approvals>) => void>();
    const approvals: TrackedSource<Approvals> = {
      get: async (id) => (id === row.id ? row : undefined),
      list: async () => ({ records: [row] }),
      watch: (_id, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const tracker = new DurabilityTracker({ sources: { approvals } });
    const [handle] = (await tracker.list()).items;

    const waiting = handle?.wait({ timeoutMs: 10_000 });
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    row = {
      ...row,
      state: { status: 'completed', result: { approvedBy: 'ana' } },
    };
    for (const listener of listeners) {
      listener();
    }

    await expect(waiting).resolves.toEqual({
      status: 'completed',
      result: { approvedBy: 'ana' },
    });
    expect(listeners.size).toBe(0);
  });

  it('re-reads a source without watch at the timeout', async () => {
    const get = vi.fn(async () => ({
      id: 'x',
      name: 'thing',
      generation: 'g',
      createdAt: 1,
      state: { status: 'pending' as const },
    }));
    const tracker = new DurabilityTracker({
      sources: { custom: { get, list: async () => ({ records: [] }) } },
    });
    const handle = await tracker.get('custom', 'x');
    get.mockClear();

    await expect(handle?.wait({ timeoutMs: 20 })).resolves.toEqual({
      status: 'pending',
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('stays off the stable entry point and stable types', () => {
    expect(Object.keys(stable)).not.toContain('DurabilityTracker');
    expectTypeOf<
      Extract<
        keyof Durability<{ resize: (call: DurableCall<null>) => number }>,
        symbol
      >
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof DurabilityAlarms<'cleanup'>, symbol>
    >().toEqualTypeOf<never>();
  });

  it('narrows handle results by source and name', () => {
    const assertTypes = async (
      durability: Durability<{
        resize: (call: DurableCall<null>) => Promise<number>;
        label: (call: DurableCall<null>) => string;
      }>,
      alarms: DurabilityAlarms<'cleanup'>
    ) => {
      const tracker = new DurabilityTracker({
        sources: { jobs: durability, alarms },
      });
      const { items } = await tracker.list({ source: 'jobs' });
      for (const item of items) {
        expectTypeOf(item.source).toEqualTypeOf<'jobs'>();
        if (item.state.status === 'completed') {
          expectTypeOf(item.state).not.toHaveProperty('result');
        }
        if (item.name === 'resize') {
          const result = await item.get();
          if (result.status === 'completed') {
            expectTypeOf(result.result).toEqualTypeOf<number>();
          }
        }
      }
      const handle = await tracker.get('alarms', 'cleanup');
      expectTypeOf(handle?.name).toEqualTypeOf<'cleanup' | undefined>();
      const { records } = await tracker.records({ source: 'jobs' });
      for (const record of records) {
        expectTypeOf(record).not.toHaveProperty('wait');
        if (record.state.status === 'completed') {
          expectTypeOf(record.state).not.toHaveProperty('result');
        }
      }
    };
    expectTypeOf(assertTypes).toBeFunction();
  });
});
