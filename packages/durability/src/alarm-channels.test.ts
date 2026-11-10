import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurabilityAlarms, type DurableAlarmInfo } from './index';
import { DurabilityTracker } from './experimental';
import { contextFor, FakeStorage } from './test-fakes';

const beforeChannels = 'durability_0004_alarms_generation_and_created_at';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('alarm channels', () => {
  it('preserves JSON-looking legacy names and pending generations on migration', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    DurabilityAlarms.migrate(context, beforeChannels);
    const name = '["library","check"]';
    storage.sql.exec(
      `INSERT INTO durability_alarms
       (name, generation_id, status, scheduled_at, next_attempt_at)
       VALUES (?, 'kept', 'pending', 0, 0)`,
      name
    );
    const legacy = vi.fn(async () => undefined);
    const current = vi.fn(async () => undefined);
    const app = new DurabilityAlarms({ context, handlers: { [name]: legacy } });
    const library = new DurabilityAlarms({
      context,
      channel: 'library',
      handlers: { check: current },
    });
    await library.check(Date.now());
    await app.alarm();
    expect(legacy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name,
        idempotencyKey: 'durability-alarm:v1:kept',
      })
    );
    expect(current).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'check' })
    );
    expect(
      storage.sql.exec('SELECT * FROM durability_alarms').toArray()
    ).toEqual([]);
  });

  it('cancels and replaces only its own occurrence and memoized values', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    const appCompute = vi.fn(() => 'app');
    const libraryCompute = vi.fn(() => 'library');
    const result: string[] = [];
    const run =
      (compute: () => string) =>
      async ({ memoize, attempt }: DurableAlarmInfo) => {
        const saved = await memoize('shared', compute);
        if (attempt === 1) {
          throw new Error('retry');
        }
        result.push(saved);
      };
    const app = new DurabilityAlarms({
      context,
      retries: { delay: () => 60_000 },
      handlers: { check: run(appCompute) },
    });
    const library = new DurabilityAlarms({
      context,
      channel: 'library',
      retries: { delay: () => 60_000 },
      handlers: { check: run(libraryCompute) },
    });
    await app.check(Date.now());
    await library.check(Date.now());
    await app.alarm();
    expect(appCompute).toHaveBeenCalledTimes(1);
    expect(libraryCompute).toHaveBeenCalledTimes(1);
    await app.check(Date.now() + 120_000);
    await expect(app.check.cancel()).resolves.toBe(true);
    const tracker = new DurabilityTracker({ sources: { app, library } });
    expect((await tracker.records()).records).toMatchObject([
      {
        source: 'library',
        id: 'check',
        state: { status: 'pending', memoized: ['shared'] },
      },
    ]);
    storage.sql.exec(
      "UPDATE durability_alarms SET next_attempt_at = 0 WHERE channel = 'library'"
    );
    await library.alarm();
    expect(result).toEqual(['library']);
    expect(libraryCompute).toHaveBeenCalledTimes(1);
    expect(
      storage.sql.exec('SELECT * FROM durability_memos').toArray()
    ).toEqual([]);
  });

  it("does not complete another channel's same-name tracker waiter", async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    const app = new DurabilityAlarms({
      context,
      handlers: { check: async () => undefined },
    });
    const library = new DurabilityAlarms({
      context,
      channel: 'library',
      handlers: { check: async () => undefined },
    });
    const tracker = new DurabilityTracker({ sources: { app, library } });
    await app.check(Date.now());
    await library.check(Date.now() + 60_000);
    const handle = await tracker.get('library', 'check');
    expect(handle).toBeDefined();
    const settled = vi.fn();
    const wait = handle!.wait({ timeoutMs: 2_000 }).then(settled);
    await app.alarm();
    expect(settled).not.toHaveBeenCalled();
    await expect(library.check.cancel()).resolves.toBe(true);
    await wait;
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('refuses downgrade without deleting records from named channels', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    const library = new DurabilityAlarms({
      context,
      channel: 'library',
      handlers: { check: async () => undefined },
    });
    await library.check(Date.now() + 60_000);
    expect(() => DurabilityAlarms.migrate(context, beforeChannels)).toThrow(
      /cannot_downgrade_nondefault_channels/
    );
    expect(
      storage.sql.exec('SELECT channel, name FROM durability_alarms').toArray()
    ).toEqual([{ channel: 'library', name: 'check' }]);
    await library.check.cancel();
    expect(
      DurabilityAlarms.migrate(context, beforeChannels).rolledBack
    ).toEqual(['durability_0016_alarms_channel']);
  });
});
