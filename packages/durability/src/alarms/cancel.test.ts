import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurabilityAlarms } from '../index';
import { contextFor, FakeStorage, waitUntilContext } from '../test-fakes';

type AlarmRecord = {
  name: string;
  generation_id: string;
  status: string;
  scheduled_at: number;
  created_at: number;
};

const readAlarmRow = (storage: FakeStorage): AlarmRecord | undefined =>
  storage.sql
    .exec<AlarmRecord>(
      'SELECT name, generation_id, status, scheduled_at, created_at FROM durability_alarms'
    )
    .toArray()[0];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('named alarm cancel', () => {
  it('deletes the pending occurrence and the physical alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const runs: number[] = [];
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: {
        tick: async ({ scheduledTime }) => {
          runs.push(scheduledTime);
        },
      },
    });

    await alarms.tick(Date.now() + 60_000);
    expect(storage.alarmAt).not.toBeNull();

    await expect(alarms.tick.cancel()).resolves.toBe(true);
    expect(readAlarmRow(storage)).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
    await expect(alarms.tick.cancel()).resolves.toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await alarms.alarm();
    expect(runs).toEqual([]);
  });

  it('aborts a running handler and leaves nothing behind when it settles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const background: Promise<unknown>[] = [];
    let releaseHandler: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let aborted = false;
    const runs: number[] = [];
    const alarms = new DurabilityAlarms({
      context: waitUntilContext(storage, background),
      handlers: {
        tick: async ({ scheduledTime, signal }) => {
          runs.push(scheduledTime);
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          await gate;
        },
      },
    });

    const first = Date.now() + 100;
    await alarms.tick(first);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(runs).toEqual([first]));

    await expect(alarms.tick.cancel()).resolves.toBe(true);
    expect(aborted).toBe(true);
    releaseHandler?.();
    await Promise.all(background);

    expect(readAlarmRow(storage)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await alarms.alarm();
    expect(runs).toEqual([first]);
    expect(storage.alarmAt).toBeNull();
  });

  it('keeps a running handler that fails from scheduling a retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const background: Promise<unknown>[] = [];
    let runs = 0;
    const alarms = new DurabilityAlarms({
      context: waitUntilContext(storage, background),
      retries: { delay: () => 0, maxAttempts: 3 },
      handlers: {
        tick: async ({ signal }) => {
          runs += 1;
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          });
        },
      },
    });

    await alarms.tick(Date.now());
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(runs).toBe(1));

    await alarms.tick.cancel();
    await Promise.all(background);
    await alarms.alarm();

    expect(readAlarmRow(storage)).toBeUndefined();
    expect(runs).toBe(1);
  });
});
