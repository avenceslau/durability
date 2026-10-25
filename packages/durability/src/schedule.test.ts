import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurabilityScheduler } from './index';
import {
  DurabilitySchedule,
  type DurabilityScheduleConfig,
  type DurabilityScheduleEvent,
  type ScheduledOutcomeDelivery,
  type ScheduledRunContext,
  type ScheduledRunOutcome,
} from './experimental';
import { contextFor, FakeStorage } from './test-fakes';

type Overrides = Partial<
  Pick<
    DurabilityScheduleConfig,
    | 'nextOccurrence'
    | 'run'
    | 'onOutcome'
    | 'maxConcurrentRuns'
    | 'runTimeoutMs'
    | 'outcomeRetries'
  >
>;

const every = (expression: string, after: number): number => {
  const interval = Number(expression);
  return (Math.floor(after / interval) + 1) * interval;
};

const setup = (
  overrides: Overrides = {},
  storage = new FakeStorage(),
  alarmHandoffMs?: number
) => {
  const background: Promise<unknown>[] = [];
  const outcomes: Array<[ScheduledOutcomeDelivery, ScheduledRunOutcome]> = [];
  const events: DurabilityScheduleEvent[] = [];
  const context = {
    ...contextFor(storage),
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
    id: 'object',
  };
  const schedule = new DurabilitySchedule({
    context,
    alarmMinDelayMs: 1_000,
    ...(alarmHandoffMs === undefined ? {} : { alarmHandoffMs }),
    nextOccurrence: every,
    run: async () => undefined,
    onOutcome: (run, outcome) => {
      outcomes.push([run, outcome]);
    },
    onLifecycleEvent: (event) => {
      events.push(event);
    },
    ...overrides,
  });
  return { storage, schedule, outcomes, events };
};

type RunRow = {
  scheduled_time: number;
  state: string;
  attempt: number;
};

const runRows = (storage: FakeStorage): RunRow[] =>
  storage.sql
    .exec<RunRow>(
      `SELECT scheduled_time, state, attempt FROM durability_schedule_runs
       ORDER BY scheduled_time`
    )
    .toArray();

const totalChanges = (storage: FakeStorage): number =>
  Number(storage.sql.exec('SELECT total_changes() AS n').toArray()[0]?.['n']);

/** Runs that stay in flight until released by scheduled time. */
const gatedRuns = () => {
  const releases = new Map<number, () => void>();
  const run = vi.fn(
    ({ scheduledTime }: ScheduledRunContext) =>
      new Promise<void>((resolve) => {
        releases.set(scheduledTime, resolve);
      })
  );
  const release = (scheduledTime: number) => releases.get(scheduledTime)?.();
  return { run, release };
};

const isSettled = (promise: Promise<unknown>) => {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  return () => settled;
};

const start = () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_500);
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DurabilitySchedule', () => {
  it('stores newer versions, ignores older ones, and repairs a lost alarm on the same version', async () => {
    start();
    const { storage, schedule } = setup();

    expect(await schedule.set({ expression: '1000', version: 2 })).toBe(true);
    expect(schedule.get()).toEqual({
      expression: '1000',
      version: 2,
      nextAt: 11_000,
    });
    expect(storage.alarmAt).toBe(11_500);

    expect(await schedule.set({ expression: '5000', version: 1 })).toBe(false);
    expect(schedule.get()?.expression).toBe('1000');

    storage.alarmAt = null;
    expect(await schedule.set({ expression: '5000', version: 2 })).toBe(false);
    expect(schedule.get()?.expression).toBe('1000');
    expect(storage.alarmAt).toBe(11_500);
  });

  it('runs a tick once, reports it, and keeps nothing afterwards', async () => {
    start();
    const run = vi.fn<(run: ScheduledRunContext) => Promise<void>>(
      async () => undefined
    );
    const { storage, schedule, outcomes, events } = setup({ run });
    await schedule.set({ expression: '1000', version: 1 });

    vi.setSystemTime(11_000);
    await schedule.alarm();

    expect(run).toHaveBeenCalledExactlyOnceWith({
      scheduledTime: 11_000,
      idempotencyKey: 'object:11000',
      signal: expect.any(AbortSignal),
    });
    expect(outcomes).toEqual([
      [
        { scheduledTime: 11_000, idempotencyKey: 'object:11000', attempt: 1 },
        { status: 'complete' },
      ],
    ]);
    expect(runRows(storage)).toEqual([]);
    expect(schedule.get()?.nextAt).toBe(12_000);
    expect(events.map((event) => event.type)).toEqual([
      'due',
      'started',
      'settled',
    ]);

    // A replayed alarm cannot fire the same tick again: the cursor moved.
    await schedule.alarm();
    expect(run).toHaveBeenCalledOnce();
  });

  it('writes four rows per run', async () => {
    start();
    const { storage, schedule, outcomes } = setup();
    await schedule.set({ expression: '1000', version: 1 });
    const before = totalChanges(storage);

    for (const time of [11_000, 12_000, 13_000]) {
      vi.setSystemTime(time);
      // eslint-disable-next-line no-await-in-loop
      await schedule.alarm();
    }

    expect(outcomes).toHaveLength(3);
    expect((totalChanges(storage) - before) / 3).toBe(4);
  });

  it('arms the physical alarm once per run in the steady state', async () => {
    start();
    const { storage, schedule, outcomes } = setup({
      run: () => new Promise((resolve) => setTimeout(resolve, 100)),
    });
    await schedule.set({ expression: '5000', version: 1 });
    const setAlarm = vi.spyOn(storage, 'setAlarm');

    for (const time of [15_000, 20_000, 25_000]) {
      vi.setSystemTime(time);
      // The platform clears a firing alarm before invoking the handler.
      storage.alarmAt = null;
      const pass = schedule.alarm();
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
      // eslint-disable-next-line no-await-in-loop
      await pass;
      expect(storage.alarmAt).toBe(time + 5_000);
    }

    expect(outcomes).toHaveLength(3);
    expect(setAlarm).toHaveBeenCalledTimes(3);
  });

  it('commits neither the run nor the cursor when nextOccurrence fails', async () => {
    start();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const nextOccurrence = vi.fn(every);
    const run = vi.fn(async () => undefined);
    const { storage, schedule } = setup({ nextOccurrence, run });
    await schedule.set({ expression: '1000', version: 1 });

    nextOccurrence.mockImplementationOnce(() => {
      throw new Error('parser broke');
    });
    vi.setSystemTime(11_000);
    await schedule.alarm();
    expect(run).not.toHaveBeenCalled();
    expect(runRows(storage)).toEqual([]);
    expect(schedule.get()?.nextAt).toBe(11_000);
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'durability.alarm.failed' })
    );

    await schedule.alarm();
    expect(run).toHaveBeenCalledOnce();
    expect(schedule.get()?.nextAt).toBe(12_000);
  });

  it('collapses missed ticks into one run for the earliest missed time', async () => {
    start();
    const { schedule, outcomes } = setup();
    await schedule.set({ expression: '1000', version: 1 });

    vi.setSystemTime(15_500);
    await schedule.alarm();

    expect(outcomes.map(([run]) => run.scheduledTime)).toEqual([11_000]);
    expect(schedule.get()?.nextAt).toBe(16_000);
  });

  it('overlaps runs up to maxConcurrentRuns, queues the rest, and holds the alarm until they finish', async () => {
    start();
    const { run, release } = gatedRuns();
    const { storage, schedule, outcomes, events } = setup({
      run,
      maxConcurrentRuns: 2,
    });
    await schedule.set({ expression: '1000', version: 1 });

    vi.setSystemTime(11_000);
    const pass = schedule.alarm();
    const passSettled = isSettled(pass);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();

    // Later ticks fire on time while the first run is still in flight.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.mock.calls.map(([call]) => call.scheduledTime)).toEqual([
      11_000, 12_000,
    ]);
    expect(runRows(storage)).toEqual([
      { scheduled_time: 11_000, state: 'running', attempt: 0 },
      { scheduled_time: 12_000, state: 'running', attempt: 0 },
      { scheduled_time: 13_000, state: 'queued', attempt: 0 },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'due',
        scheduledTime: 13_000,
        queued: true,
      })
    );
    expect(passSettled()).toBe(false);

    release(11_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(3);
    expect(outcomes.map(([delivery]) => delivery.scheduledTime)).toEqual([
      11_000,
    ]);

    await schedule.cancel();
    release(12_000);
    release(13_000);
    await vi.advanceTimersByTimeAsync(0);
    await pass;
    expect(outcomes.map(([delivery]) => delivery.scheduledTime)).toEqual([
      11_000, 12_000, 13_000,
    ]);
    expect(runRows(storage)).toEqual([]);
  });

  it('hands off before the alarm wall-time limit and rejoins from the next alarm', async () => {
    start();
    const { run, release } = gatedRuns();
    const { storage, schedule, outcomes } = setup(
      { run },
      new FakeStorage(),
      100
    );
    await schedule.set({ expression: '1000', version: 1 });

    // The platform clears a firing alarm before invoking the handler.
    vi.setSystemTime(11_000);
    storage.alarmAt = null;
    const first = schedule.alarm();
    await vi.advanceTimersByTimeAsync(100);
    await first;
    expect(storage.alarmAt).toBe(12_000);

    vi.setSystemTime(12_000);
    storage.alarmAt = null;
    const second = schedule.alarm();
    const secondSettled = isSettled(second);
    await vi.advanceTimersByTimeAsync(50);
    expect(run.mock.calls.map(([call]) => call.scheduledTime)).toEqual([
      11_000, 12_000,
    ]);
    expect(secondSettled()).toBe(false);

    await schedule.cancel();
    release(11_000);
    release(12_000);
    await vi.advanceTimersByTimeAsync(0);
    await second;
    expect(outcomes).toHaveLength(2);
  });

  it('keeps a timed-out run in its slot until the handler settles', async () => {
    start();
    let finish: (() => void) | undefined;
    const signals: AbortSignal[] = [];
    const run = vi.fn(
      ({ signal }: ScheduledRunContext) =>
        new Promise<void>((resolve) => {
          signals.push(signal);
          finish = resolve;
        })
    );
    const { storage, schedule, outcomes } = setup({
      run,
      runTimeoutMs: 100,
      maxConcurrentRuns: 1,
    });
    await schedule.set({ expression: '1000', version: 1 });

    vi.setSystemTime(11_000);
    const pass = schedule.alarm();
    await vi.advanceTimersByTimeAsync(100);
    expect(signals[0]?.aborted).toBe(true);
    expect(outcomes).toEqual([
      [
        expect.objectContaining({ scheduledTime: 11_000 }),
        {
          status: 'errored',
          error: {
            name: 'ScheduledRunTimeoutError',
            message: 'Scheduled run timed out after 100ms',
          },
        },
      ],
    ]);

    await vi.advanceTimersByTimeAsync(900);
    expect(runRows(storage)).toEqual([
      { scheduled_time: 12_000, state: 'queued', attempt: 0 },
    ]);

    await schedule.cancel();
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    await pass;
    expect(runRows(storage)).toEqual([]);
  });

  it('reports a run left running by a previous instance as errored instead of re-running it', async () => {
    start();
    const storage = new FakeStorage();
    const first = setup({ run: () => new Promise(() => undefined) }, storage);
    await first.schedule.set({ expression: '1000', version: 1 });
    vi.setSystemTime(11_000);
    void first.schedule.alarm();
    await vi.advanceTimersByTimeAsync(0);
    expect(runRows(storage)).toEqual([
      { scheduled_time: 11_000, state: 'running', attempt: 0 },
    ]);

    const run = vi.fn(async () => undefined);
    const second = setup({ run }, storage);
    await second.schedule.alarm();

    expect(run).not.toHaveBeenCalled();
    expect(second.outcomes).toEqual([
      [
        { scheduledTime: 11_000, idempotencyKey: 'object:11000', attempt: 1 },
        {
          status: 'errored',
          error: {
            name: 'ScheduledRunInterruptedError',
            message:
              'Scheduled run was interrupted before it reported an outcome',
          },
        },
      ],
    ]);
    expect(runRows(storage)).toEqual([]);
  });

  it('retries a failed outcome delivery durably until it is acknowledged', async () => {
    start();
    const onOutcome = vi
      .fn<DurabilityScheduleConfig['onOutcome']>()
      .mockRejectedValueOnce(new Error('sink down'))
      .mockResolvedValue(undefined);
    const { storage, schedule, events } = setup({
      nextOccurrence: (_expression, after) =>
        after < 11_000 ? 11_000 : undefined,
      onOutcome,
      outcomeRetries: { delay: () => 500 },
    });
    await schedule.set({ expression: 'once', version: 1 });

    vi.setSystemTime(11_000);
    await schedule.alarm();
    expect(runRows(storage)).toEqual([
      { scheduled_time: 11_000, state: 'complete', attempt: 1 },
    ]);
    expect(storage.alarmAt).not.toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'outcome_retry',
        attempt: 1,
        nextAttemptAt: 11_500,
        error: { name: 'Error', message: 'sink down' },
      })
    );

    vi.setSystemTime(11_500);
    await schedule.alarm();
    expect(onOutcome.mock.calls.map(([run]) => run.attempt)).toEqual([1, 2]);
    expect(runRows(storage)).toEqual([]);
  });

  it('dead-letters an outcome after maxAttempts deliveries', async () => {
    start();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onOutcome = vi
      .fn<DurabilityScheduleConfig['onOutcome']>()
      .mockRejectedValue(new Error('sink down'));
    const { storage, schedule, events } = setup({
      nextOccurrence: (_expression, after) =>
        after < 11_000 ? 11_000 : undefined,
      onOutcome,
      outcomeRetries: { maxAttempts: 2, delay: () => 0 },
    });
    await schedule.set({ expression: 'once', version: 1 });

    vi.setSystemTime(11_000);
    await schedule.alarm();
    await schedule.alarm();

    expect(onOutcome).toHaveBeenCalledTimes(2);
    expect(runRows(storage)).toEqual([]);
    expect(events[events.length - 1]).toEqual({
      entityKind: 'scheduled_run',
      type: 'dead_lettered',
      id: 'object:11000',
      scheduledTime: 11_000,
      timestamp: 11_000,
      attempt: 2,
      error: { name: 'Error', message: 'sink down' },
    });
    expect(storage.alarmAt).toBeNull();
  });

  it('cancels future ticks while letting a running run report', async () => {
    start();
    const { run, release } = gatedRuns();
    const { schedule, outcomes } = setup({ run });
    await schedule.set({ expression: '1000', version: 3 });

    vi.setSystemTime(11_000);
    const pass = schedule.alarm();
    await vi.advanceTimersByTimeAsync(0);
    expect(await schedule.cancel()).toBe(true);
    expect(schedule.get()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5_000);
    release(11_000);
    await pass;
    expect(run).toHaveBeenCalledOnce();
    expect(outcomes).toHaveLength(1);
    expect(await schedule.cancel()).toBe(false);
  });

  it('records a versioned cancel so an older set cannot revive the schedule', async () => {
    start();
    const { schedule } = setup();
    await schedule.set({ expression: '1000', version: 3 });

    expect(await schedule.cancel(2)).toBe(false);
    expect(schedule.get()?.version).toBe(3);
    expect(await schedule.cancel(4)).toBe(true);
    expect(await schedule.set({ expression: '1000', version: 4 })).toBe(false);
    expect(schedule.get()).toBeUndefined();
    expect(await schedule.set({ expression: '2000', version: 5 })).toBe(true);
    expect(schedule.get()).toEqual({
      expression: '2000',
      version: 5,
      nextAt: 12_000,
    });
  });

  it('ends ticks when nextOccurrence returns undefined and rejects invalid times', async () => {
    start();
    const { storage, schedule } = setup({
      nextOccurrence: (expression, after) =>
        expression === 'never' ? undefined : after,
    });

    expect(await schedule.set({ expression: 'never', version: 1 })).toBe(true);
    expect(schedule.get()).toEqual({
      expression: 'never',
      version: 1,
      nextAt: undefined,
    });
    expect(storage.alarmAt).toBeNull();
    await expect(
      schedule.set({ expression: 'now', version: 2 })
    ).rejects.toThrow(RangeError);
  });

  it('attaches once per scheduler', () => {
    const storage = new FakeStorage();
    const scheduler = new DurabilityScheduler({
      context: contextFor(storage),
    });
    const config = {
      scheduler,
      nextOccurrence: every,
      run: () => undefined,
      onOutcome: () => undefined,
    };
    expect(() => new DurabilitySchedule(config)).not.toThrow();
    expect(() => new DurabilitySchedule(config)).toThrow(
      'already attached to this scheduler'
    );
  });
});
