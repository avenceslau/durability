import { afterEach, describe, expect, it, vi } from 'vitest';
import { Durability, type DurableCall } from './index';
import { contextFor, FakeStorage } from './test-fakes';

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
