import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedTimer } from './shared-timer';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SharedTimer', () => {
  it('runs callbacks in order of due time, not of scheduling', () => {
    const timer = new SharedTimer();
    const ran: number[] = [];

    for (const delayMs of [90, 30, 60]) {
      timer.schedule(() => ran.push(delayMs), delayMs);
    }

    vi.advanceTimersByTime(30);
    expect(ran).toEqual([30]);
    vi.advanceTimersByTime(60);
    expect(ran).toEqual([30, 60, 90]);
    expect(timer.pendingCount).toBe(0);
  });

  it('runs callbacks due at the same time in the order they were scheduled', () => {
    const timer = new SharedTimer();
    const ran: number[] = [];

    for (let index = 0; index < 50; index += 1) {
      timer.schedule(() => ran.push(index), 20);
    }
    vi.advanceTimersByTime(20);

    expect(ran).toEqual(Array.from({ length: 50 }, (_, index) => index));
  });

  it('holds one native timer however many callbacks are pending', () => {
    const timer = new SharedTimer();
    const cancels = Array.from({ length: 25_000 }, (_, index) =>
      timer.schedule(() => undefined, 60_000 + index)
    );

    expect(timer.pendingCount).toBe(25_000);
    expect(vi.getTimerCount()).toBe(1);

    for (const cancel of cancels) {
      cancel();
    }

    expect(timer.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs a short timeout on time behind many long ones', () => {
    const timer = new SharedTimer();
    const short = vi.fn();
    for (let index = 0; index < 15_000; index += 1) {
      timer.schedule(() => undefined, 3_600_000);
    }

    timer.schedule(short, 50);
    vi.advanceTimersByTime(49);
    expect(short).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(short).toHaveBeenCalledOnce();
    expect(timer.pendingCount).toBe(15_000);
  });

  it('keeps later callbacks on time when the earliest is cancelled', () => {
    const timer = new SharedTimer();
    const earliest = vi.fn();
    const later = vi.fn();

    const cancelEarliest = timer.schedule(earliest, 20);
    timer.schedule(later, 60);
    cancelEarliest();

    vi.advanceTimersByTime(59);
    expect(later).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(later).toHaveBeenCalledOnce();
    expect(earliest).not.toHaveBeenCalled();
  });

  it('removes a cancelled callback from anywhere in the heap', () => {
    const timer = new SharedTimer();
    const ran: number[] = [];
    const delays = Array.from(
      { length: 200 },
      (_, index) => (index * 37) % 200
    );
    const cancels = delays.map((delayMs) =>
      timer.schedule(() => ran.push(delayMs), delayMs)
    );

    for (const [index, delayMs] of delays.entries()) {
      if (delayMs % 3 === 0) {
        cancels[index]?.();
      }
    }
    vi.advanceTimersByTime(200);

    expect(ran).toEqual(
      Array.from({ length: 200 }, (_, delayMs) => delayMs).filter(
        (delayMs) => delayMs % 3 !== 0
      )
    );
  });

  it('ignores a cancel after the callback ran or was already cancelled', () => {
    const timer = new SharedTimer();
    const other = vi.fn();
    const cancelRan = timer.schedule(() => undefined, 10);
    const cancelTwice = timer.schedule(() => undefined, 40);
    timer.schedule(other, 30);

    vi.advanceTimersByTime(10);
    cancelRan();
    cancelTwice();
    cancelTwice();
    expect(timer.pendingCount).toBe(1);

    vi.advanceTimersByTime(20);
    expect(other).toHaveBeenCalledOnce();
  });

  it('runs a callback scheduled from inside another callback', () => {
    const timer = new SharedTimer();
    const inner = vi.fn();
    timer.schedule(() => {
      timer.schedule(inner, 25);
    }, 10);

    vi.advanceTimersByTime(34);
    expect(inner).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(inner).toHaveBeenCalledOnce();
  });

  it('sets the next native timer before running the due callbacks', () => {
    const timer = new SharedTimer();
    let nativeTimersDuringCallback = 0;
    timer.schedule(() => {
      nativeTimersDuringCallback = vi.getTimerCount();
    }, 10);
    timer.schedule(() => undefined, 20);

    vi.advanceTimersByTime(10);

    expect(nativeTimersDuringCallback).toBe(1);
  });

  it('skips a callback cancelled by one due at the same time', () => {
    const timer = new SharedTimer();
    const cancelled = vi.fn();
    let cancel = (): void => undefined;
    timer.schedule(() => cancel(), 10);
    cancel = timer.schedule(cancelled, 10);

    vi.advanceTimersByTime(10);

    expect(cancelled).not.toHaveBeenCalled();
    expect(timer.pendingCount).toBe(0);
  });

  it('runs a callback scheduled with no delay after those already due', () => {
    const timer = new SharedTimer();
    const ran: string[] = [];
    timer.schedule(() => {
      ran.push('first');
      timer.schedule(() => ran.push('scheduled by first'), 0);
    }, 10);
    timer.schedule(() => ran.push('second'), 10);

    vi.advanceTimersByTime(10);
    expect(ran).toEqual(['first', 'second']);
    // Fake timers give a timer set from inside another a delay of at least 1 ms.
    vi.advanceTimersByTime(1);

    expect(ran).toEqual(['first', 'second', 'scheduled by first']);
  });

  it('keeps running later callbacks after one throws', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const timer = new SharedTimer();
    const sameTime = vi.fn();
    const later = vi.fn();

    timer.schedule(() => {
      throw new Error('callback failed');
    }, 10);
    timer.schedule(sameTime, 10);
    timer.schedule(later, 20);
    vi.advanceTimersByTime(20);

    expect(sameTime).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'durability.timer.callback_failed' })
    );
  });

  it('drops a callback whose native timer could not be set', () => {
    const timer = new SharedTimer();
    const callback = vi.fn();
    vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
      throw new Error('too many timers');
    });

    expect(() => timer.schedule(callback, 10)).toThrow('too many timers');
    expect(timer.pendingCount).toBe(0);

    const later = vi.fn();
    timer.schedule(later, 20);
    vi.advanceTimersByTime(20);
    expect(later).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });

  it('sets the native timer again after it could not be set between runs', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const timer = new SharedTimer();
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    timer.schedule(first, 10);
    timer.schedule(second, 20);
    vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
      throw new Error('too many timers');
    });

    vi.advanceTimersByTime(10);
    expect(first).toHaveBeenCalledOnce();
    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'durability.timer.set_failed',
        pendingCount: 1,
      })
    );
    expect(vi.getTimerCount()).toBe(0);

    timer.schedule(third, 100);
    vi.advanceTimersByTime(10);
    expect(second).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(90);
    expect(third).toHaveBeenCalledOnce();
  });

  it('waits out a delay longer than setTimeout accepts', () => {
    const timer = new SharedTimer();
    const callback = vi.fn();
    const delayMs = 2 ** 31 + 1_000;
    timer.schedule(callback, delayMs);

    vi.advanceTimersByTime(delayMs - 1);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('runs a callback whose native timer fires a fraction of a millisecond early', () => {
    // workerd drops the fraction of a delay, and its clock stands still while
    // code runs, so a timer set again for the remainder would fire forever.
    const fakeSetTimeout = globalThis.setTimeout;
    const setNative = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, delayMs) =>
        fakeSetTimeout(callback, Math.trunc(delayMs ?? 0))
      );
    const timer = new SharedTimer();
    const callback = vi.fn();
    timer.schedule(callback, 10.5);

    vi.advanceTimersByTime(10);

    expect(callback).toHaveBeenCalledOnce();
    expect(setNative).toHaveBeenCalledOnce();
  });

  it('treats a negative or NaN delay as zero', () => {
    const timer = new SharedTimer();
    const callback = vi.fn();
    timer.schedule(callback, -5);
    timer.schedule(callback, Number.NaN);

    vi.advanceTimersByTime(0);

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('settles withTimeout like the work and cancels the timeout', async () => {
    const timer = new SharedTimer();
    const onTimeout = vi.fn(() => new Error('timed out'));

    await expect(
      timer.withTimeout(Promise.resolve('done'), 1_000, onTimeout)
    ).resolves.toBe('done');
    await expect(
      timer.withTimeout(Promise.reject(new Error('failed')), 1_000, onTimeout)
    ).rejects.toThrow('failed');

    expect(timer.pendingCount).toBe(0);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('rejects withTimeout once the work is pending past the timeout', async () => {
    const timer = new SharedTimer();
    const work = new Promise<never>(() => {});
    const outcome = timer
      .withTimeout(work, 1_000, () => new Error('timed out'))
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(999);
    expect(timer.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toEqual(new Error('timed out'));
    expect(timer.pendingCount).toBe(0);
  });

  it('counts elapsed time, so a wall clock change moves no callback', () => {
    const timer = new SharedTimer();
    const before = vi.fn();
    const after = vi.fn();
    timer.schedule(before, 30_000);

    vi.setSystemTime(Date.now() + 3_600_000);
    timer.schedule(after, 10_000);

    vi.advanceTimersByTime(10_000);
    expect(after).toHaveBeenCalledOnce();
    expect(before).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(before).toHaveBeenCalledOnce();
  });
});
