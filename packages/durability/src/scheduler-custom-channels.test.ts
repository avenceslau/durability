import { afterEach, expect, it, vi } from 'vitest';
import { DurabilityScheduler } from './index';
import { engineFor } from './scheduler';
import { contextFor, FakeStorage } from './test-fakes';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps one held channel from suppressing another channel's timer", async () => {
  vi.useFakeTimers();
  const storage = new FakeStorage();
  const scheduler = new DurabilityScheduler({ context: contextFor(storage) });
  const engine = engineFor({ scheduler });
  storage.sql.exec(
    'CREATE TABLE custom_work (channel TEXT, id INTEGER, next_at INTEGER)'
  );
  const start = Date.now();
  storage.sql.exec(
    'INSERT INTO custom_work VALUES (?, 1, ?), (?, 1, ?)',
    'held',
    start,
    'ready',
    start + 5_000
  );
  const next = (channel: string) =>
    storage.sql
      .exec<{ next_at: number | null }>(
        'SELECT next_at FROM custom_work WHERE channel = ?',
        channel
      )
      .one().next_at ?? undefined;
  const ready = vi.fn(async () => {
    storage.sql.exec(
      "UPDATE custom_work SET next_at = NULL WHERE channel = 'ready'"
    );
  });
  engine.registerChannel({
    table: { name: 'custom_work', key: 'id' },
    channel: 'held',
    helper: 'Custom',
    runDue: async () => undefined,
    nextPendingAt: () => next('held'),
    holding: () => true,
  });
  engine.registerChannel({
    table: { name: 'custom_work', key: 'id' },
    channel: 'ready',
    helper: 'Custom',
    runDue: ready,
    nextPendingAt: () => next('ready'),
  });
  await engine.scheduleNextAlarm();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(ready).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(ready).toHaveBeenCalledTimes(1);
  expect(storage.alarmAt).not.toBeNull();
});

it('retains missing custom-timed channels without executing their work', async () => {
  const storage = new FakeStorage();
  const scheduler = new DurabilityScheduler({ context: contextFor(storage) });
  const engine = engineFor({ scheduler });
  storage.sql.exec(
    'CREATE TABLE custom_work (channel TEXT, id INTEGER, expires_at INTEGER)'
  );
  storage.sql.exec("INSERT INTO custom_work VALUES ('removed', 1, 0)");
  engine.registerChannel({
    table: { name: 'custom_work', key: 'id' },
    channel: 'default',
    helper: 'Custom',
    runDue: async () => undefined,
    nextPendingAt: () => undefined,
  });
  const reported = vi
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  await scheduler.alarm();
  await scheduler.alarm();
  expect(storage.sql.exec('SELECT * FROM custom_work').toArray()).toEqual([
    { channel: 'removed', id: 1, expires_at: 0 },
  ]);
  expect(reported).toHaveBeenCalledTimes(1);
  expect(reported).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'durability.channel_missing' })
  );
  expect(storage.alarmAt).toBeNull();
});

it('reserves channels for capabilities without alarm work', () => {
  const scheduler = new DurabilityScheduler({
    context: contextFor(new FakeStorage()),
  });
  const engine = engineFor({ scheduler });
  engine.claimChannel('records', 'default', 'Records');
  engine.claimChannel('records', 'library', 'Records');
  expect(() => engine.claimChannel('records', 'library', 'Records')).toThrow(
    'Records for channel "library" is already attached'
  );
  expect(() =>
    engine.claimChannel('other-records', 'library', 'Other')
  ).not.toThrow();
});
