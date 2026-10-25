import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Durability,
  DurabilityAlarms,
  DurabilityScheduler,
  type DurableCall,
} from './index';
import { contextFor, FakeStorage } from './test-fakes';

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

const waitUntilContext = (storage: FakeStorage, sink: Promise<unknown>[]) => ({
  ...contextFor(storage),
  waitUntil(promise: Promise<unknown>) {
    sink.push(promise);
  },
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('liveTimers scheduler option', () => {
  it('fires an in-memory timer at the exact time beyond alarmMinDelayMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const handler = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('retry'))
      .mockResolvedValue('done');
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: handler },
      retries: { delay: () => 5_000 },
      alarmMinDelayMs: 1_000,
      liveTimers: true,
    });

    await durability.work({ id: 'live', payload: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);

    // The physical alarm stays armed as the eviction fallback.
    expect(storage.alarmAt).toBe(Date.now() + 5_000);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    await expect(durability.work.getResult('live')).resolves.toEqual({
      status: 'completed',
      result: 'done',
    });
    expect(storage.alarmAt).toBeNull();
  });

  it('leaves retries beyond alarmMinDelayMs to the physical alarm by default', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const handler = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('retry'))
      .mockResolvedValue('done');
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: handler },
      retries: { delay: () => 5_000 },
      alarmMinDelayMs: 1_000,
    });

    await durability.work({ id: 'fallback', payload: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(storage.alarmAt).toBe(Date.now() + 5_000);

    // No in-memory timer is armed past the min-delay window, so advancing time
    // alone never re-runs the handler; only the physical alarm would.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(handler).toHaveBeenCalledTimes(1);

    await durability.alarm();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
  });

  it('runs newly due work without waiting behind a long-running handler', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    let releaseLong: (() => void) | undefined;
    const long = new Promise<void>((resolve) => {
      releaseLong = resolve;
    });
    const longHandler = vi.fn(async (_call: DurableCall<null>) => long);
    const quickHandler = vi.fn(async (_call: DurableCall<null>) => 'quick');
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { long: longHandler, quick: quickHandler },
      alarmConcurrency: 5,
      alarmMinDelayMs: 1_000,
      liveTimers: true,
    });

    await durability.long({ id: 'long', payload: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(longHandler).toHaveBeenCalledTimes(1);

    // A second operation becomes due while the long handler is still running.
    await durability.quick({ id: 'quick', payload: null });
    await vi.waitFor(() => expect(quickHandler).toHaveBeenCalledTimes(1));
    await expect(durability.quick.getResult('quick')).resolves.toMatchObject({
      status: 'completed',
    });

    releaseLong?.();
  });
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

describe('onAlarmRetry scheduler option', () => {
  const failingRun = (storage: FakeStorage) => {
    storage.getAlarm = () => Promise.reject(new Error('storage unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  };

  it('reports a failed alarm run with the platform retry count', async () => {
    const storage = new FakeStorage();
    const background: Promise<unknown>[] = [];
    const onAlarmRetry = vi.fn();
    const scheduler = new DurabilityScheduler({
      context: waitUntilContext(storage, background),
      alarmMinDelayMs: 1_000,
      onAlarmRetry,
    });
    failingRun(storage);

    await expect(
      scheduler.alarm({ retryCount: 2, isRetry: true, scheduledTime: 0 })
    ).resolves.toBeUndefined();

    expect(onAlarmRetry).toHaveBeenCalledExactlyOnceWith({
      error: { name: 'Error', message: 'storage unavailable' },
      retryInMs: 1_000,
      retryCount: 2,
      isRetry: true,
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'durability.alarm.failed' })
    );
  });

  it('never lets the hook change scheduling', async () => {
    const storage = new FakeStorage();
    const background: Promise<unknown>[] = [];
    const scheduler = new DurabilityScheduler({
      context: waitUntilContext(storage, background),
      alarmMinDelayMs: 1_000,
      onAlarmRetry: () => {
        throw new Error('hook broke');
      },
    });
    const rejecting = new DurabilityScheduler({
      context: waitUntilContext(storage, background),
      alarmMinDelayMs: 1_000,
      onAlarmRetry: () => Promise.reject(new Error('hook rejected')),
    });
    failingRun(storage);
    const before = Date.now();

    await expect(scheduler.alarm()).resolves.toBeUndefined();
    await expect(rejecting.alarm()).resolves.toBeUndefined();
    await Promise.all(background);

    expect(background).toHaveLength(1);
    expect(storage.alarmAt).toBeGreaterThanOrEqual(before + 1_000);
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'durability.alarm.retry_hook_failed' })
    );
  });

  it('is not called when the fallback cannot be armed', async () => {
    const storage = new FakeStorage();
    const onAlarmRetry = vi.fn();
    const scheduler = new DurabilityScheduler({
      context: contextFor(storage),
      onAlarmRetry,
    });
    failingRun(storage);
    storage.setAlarm = () => Promise.reject(new Error('storage unavailable'));

    await expect(scheduler.alarm()).rejects.toThrow('storage unavailable');
    expect(onAlarmRetry).not.toHaveBeenCalled();
  });

  it('reaches the private scheduler of a helper configured with context', async () => {
    const storage = new FakeStorage();
    const onAlarmRetry = vi.fn();
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: async (_call: DurableCall<null>) => undefined },
      onAlarmRetry,
    });
    failingRun(storage);

    await durability.alarm();
    expect(onAlarmRetry).toHaveBeenCalledOnce();
  });
});
