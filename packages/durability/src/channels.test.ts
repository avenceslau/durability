import { afterEach, describe, expect, it, vi } from 'vitest';
import { Durability, DurabilityScheduler, type DurableCall } from './index';
import { DurabilityTracker } from './experimental';
import { contextFor, FakeStorage } from './test-fakes';

const beforeChannels = 'durability_0004_calls_generation_and_created_at';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('operation channels', () => {
  it('migrates arbitrary legacy IDs without collisions or losing memoized results', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    Durability.migrate(context, beforeChannels);
    const id = '["library","a"]';
    storage.sql.exec(
      `INSERT INTO durability_calls
       (id, operation, payload, status, attempt, next_attempt_at, generation_id)
       VALUES (?, 'work', '{"kind":"value","value":null}', 'pending', 1, 0, 'kept')`,
      id
    );
    storage.sql.exec(`CREATE TABLE durability_memos (
      owner TEXT NOT NULL, key TEXT NOT NULL, generation_id TEXT NOT NULL,
      memo_key TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY (owner, key, generation_id, memo_key)
    )`);
    storage.sql.exec(
      `INSERT INTO durability_memos VALUES
       ('durability_calls', ?, 'kept', 'saved', '{"kind":"value","value":"legacy"}')`,
      id
    );
    const recompute = vi.fn(() => 'wrong');
    const app = new Durability({
      context,
      handlers: {
        work: ({ memoize }: DurableCall<null>) => memoize('saved', recompute),
      },
    });
    const library = new Durability({
      context,
      channel: 'library',
      handlers: {
        work: ({ id: callId }: DurableCall<null>) => `library:${callId}`,
      },
    });
    await library.work({ id: 'a', payload: null });
    await app.alarm();
    await expect(app.work.getResult(id)).resolves.toEqual({
      status: 'completed',
      result: 'legacy',
    });
    await expect(library.work.getResult('a')).resolves.toEqual({
      status: 'completed',
      result: 'library:a',
    });
    expect(recompute).not.toHaveBeenCalled();
    expect(
      storage.sql.exec('SELECT * FROM durability_memos').toArray()
    ).toEqual([]);
  });

  it.each(['same', '["library","a"]', 'quotes" / \\ ☃', '\u0000key'])(
    'isolates the exact ID %j across channels',
    async (id) => {
      const storage = new FakeStorage();
      const context = contextFor(storage);
      const app = new Durability({ context, handlers: { work: () => 'app' } });
      const library = new Durability({
        context,
        channel: 'library',
        handlers: { work: () => 'library' },
      });
      await app.work({ id, payload: null });
      await library.work({ id, payload: null });
      await app.alarm();
      await expect(app.work.getResult(id)).resolves.toEqual({
        status: 'completed',
        result: 'app',
      });
      await expect(library.work.getResult(id)).resolves.toEqual({
        status: 'completed',
        result: 'library',
      });
      const tracker = new DurabilityTracker({ sources: { app, library } });
      expect(
        (await tracker.records()).records.map(({ source, id: callId }) => [
          source,
          callId,
        ])
      ).toEqual([
        ['app', id],
        ['library', id],
      ]);
    }
  );

  it('isolates memo cleanup and retry state even with the same ID and generation', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    const appCompute = vi.fn(() => 'app');
    const libraryCompute = vi.fn(() => 'library');
    const run =
      (compute: () => string) =>
      async ({ memoize, attempt }: DurableCall<null>) => {
        const result = await memoize('saved', compute);
        if (attempt === 1) {
          throw new Error('retry');
        }
        return result;
      };
    const app = new Durability({
      context,
      retries: { delay: () => 60_000 },
      handlers: { work: run(appCompute) },
    });
    const library = new Durability({
      context,
      channel: 'library',
      retries: { delay: () => 60_000 },
      handlers: { work: run(libraryCompute) },
    });
    for (const channel of ['default', 'library']) {
      storage.sql.exec(
        `INSERT INTO durability_calls
         (channel, id, operation, payload, status, attempt, next_attempt_at)
         VALUES (?, 'same', 'work', '{"kind":"value","value":null}', 'pending', 0, 0)`,
        channel
      );
    }
    await app.alarm();
    expect(appCompute).toHaveBeenCalledTimes(1);
    expect(libraryCompute).toHaveBeenCalledTimes(1);
    await app.purgeBefore(Date.now() + 1);
    const tracker = new DurabilityTracker({ sources: { library } });
    expect((await tracker.records()).records[0]?.state).toMatchObject({
      status: 'pending',
      memoized: ['saved'],
    });
    storage.sql.exec(
      "UPDATE durability_calls SET next_attempt_at = 0 WHERE channel = 'library'"
    );
    await library.alarm();
    await expect(library.work.getResult('same')).resolves.toEqual({
      status: 'completed',
      result: 'library',
    });
    expect(libraryCompute).toHaveBeenCalledTimes(1);
    expect(
      storage.sql.exec('SELECT * FROM durability_memos').toArray()
    ).toEqual([]);
  });

  it('refuses a destructive downgrade while non-default records exist', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    const library = new Durability({
      context,
      channel: 'library',
      handlers: { work: () => 'kept' },
    });
    await library.work({ id: 'same', payload: null });
    await library.alarm();
    expect(() => Durability.migrate(context, beforeChannels)).toThrow(
      /cannot_downgrade_nondefault_channels/
    );
    await expect(library.work.getResult('same')).resolves.toEqual({
      status: 'completed',
      result: 'kept',
    });
    expect(
      storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE name = 'durability_calls_channel_guard'"
        )
        .toArray()
    ).toEqual([]);
    await library.purgeBefore(Date.now() + 1);
    expect(Durability.migrate(context, beforeChannels).rolledBack).toEqual([
      'durability_0015_calls_channel',
    ]);
  });

  it("does not treat another channel's same-ID work as active with live timers", async () => {
    vi.useFakeTimers();
    const storage = new FakeStorage();
    const scheduler = new DurabilityScheduler({
      context: contextFor(storage),
      liveTimers: true,
    });
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const app = new Durability({ scheduler, handlers: { work: () => slow } });
    const work = vi.fn(() => 'library');
    const library = new Durability({
      scheduler,
      channel: 'library',
      handlers: { work },
    });
    await app.work({ id: 'same', payload: null });
    await vi.advanceTimersByTimeAsync(0);
    storage.sql.exec(
      `INSERT INTO durability_calls
       (channel, id, operation, payload, status, attempt, next_attempt_at)
       VALUES ('library', 'same', 'work', '{"kind":"value","value":null}', 'pending', 0, ?)`,
      Date.now()
    );
    await library.purgeBefore(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(library.work.getResult('same')).resolves.toEqual({
      status: 'completed',
      result: 'library',
    });
    expect(work).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1);
  });
});
