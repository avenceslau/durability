import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { DurabilityAlarms, every, type DurabilityAlarmEvent } from '../index';
import { contextFor, FakeStorage } from '../test-fakes';

type Level = 'draining' | 'active' | 'inactive';

type AlarmState = {
  name: string;
  generation_id: string;
  status: string;
  attempt: number;
  next_attempt_at: number;
};

const readAlarms = (storage: FakeStorage): AlarmState[] =>
  storage.sql
    .exec<AlarmState>(
      `SELECT name, generation_id, status, attempt, next_attempt_at
       FROM durability_alarms ORDER BY name`
    )
    .toArray();

const startClock = (): void => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
};

const runNextOccurrence = async (
  storage: FakeStorage,
  alarms: { alarm: () => Promise<void> }
): Promise<void> => {
  const [next] = readAlarms(storage)
    .map((row) => row.next_attempt_at)
    .sort((left, right) => left - right);

  if (next === undefined) {
    throw new Error('no pending occurrence');
  }

  vi.setSystemTime(next);
  storage.alarmAt = null;
  await alarms.alarm();
};

const startBlockedSweep = async (storage: FakeStorage) => {
  let finish: () => void = () => undefined;

  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const alarms = new DurabilityAlarms({
    context: contextFor(storage),
    activity: (): Level => 'active',
    handlers: { sweep: every({ active: 30_000 }, () => running) },
  });

  const start = Date.now();
  await alarms.sweep(start);
  storage.alarmAt = null;
  const pass = alarms.alarm();
  await vi.waitFor(() => expect(readAlarms(storage)[0]?.attempt).toBe(1));

  return { alarms, start, finish, pass };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('every', () => {
  it('checks levels against the activity type', () => {
    const activity = (): Level => 'active';

    const alarms = new DurabilityAlarms({
      context: contextFor(new FakeStorage()),
      activity,
      handlers: {
        sweep: every({ draining: 5_000, active: 30_000 }, ({ level }) => {
          expectTypeOf(level).toEqualTypeOf<'draining' | 'active'>();
        }),
        snapshot: every({ '*': 3_600_000, inactive: () => 1 }, ({ level }) => {
          expectTypeOf(level).toEqualTypeOf<string | undefined>();
        }),
        plain: async () => undefined,
      },
    });

    expectTypeOf(alarms.raiseActivity).parameter(0).toEqualTypeOf<Level>();
    expectTypeOf(alarms.sweep).toBeFunction();

    const assertInvalidTypes = () => {
      void new DurabilityAlarms({
        context: contextFor(new FakeStorage()),
        activity,
        // @ts-expect-error every() levels must be levels activity returns
        handlers: { sweep: every({ activ: 5_000 }, () => undefined) },
      });
      void new DurabilityAlarms({
        context: contextFor(new FakeStorage()),
        // @ts-expect-error levels need an activity option
        handlers: { sweep: every({ active: 5_000 }, () => undefined) },
      });
      // @ts-expect-error raiseActivity takes a level activity returns
      void alarms.raiseActivity('idle');

      const fixed = new DurabilityAlarms({
        context: contextFor(new FakeStorage()),
        handlers: { tick: every(60_000, () => undefined) },
      });

      // @ts-expect-error raiseActivity needs an activity option
      void fixed.raiseActivity('active');
    };

    expectTypeOf(assertInvalidTypes).toBeFunction();
  });

  it('schedules the next occurrence from the level after each run', async () => {
    startClock();
    const storage = new FakeStorage();
    let level: Level = 'draining';
    const runs: Array<{ at: number; level: string }> = [];

    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      activity: () => level,
      handlers: {
        sweep: every({ draining: 5_000, active: 30_000 }, (info) => {
          runs.push({ at: Date.now(), level: info.level });
        }),
      },
    });

    const start = Date.now();
    await alarms.sweep(start);
    await runNextOccurrence(storage, alarms);
    await runNextOccurrence(storage, alarms);
    level = 'active';
    await runNextOccurrence(storage, alarms);
    await runNextOccurrence(storage, alarms);

    expect(runs).toEqual([
      { at: start, level: 'draining' },
      { at: start + 5_000, level: 'draining' },
      { at: start + 10_000, level: 'active' },
      { at: start + 40_000, level: 'active' },
    ]);
    expect(readAlarms(storage)).toEqual([
      expect.objectContaining({
        name: 'sweep',
        status: 'pending',
        attempt: 0,
        next_attempt_at: start + 70_000,
      }),
    ]);
  });

  it('skips and stops at a level without a period', async () => {
    startClock();
    const storage = new FakeStorage();
    let level: Level = 'active';
    const sweep = vi.fn();

    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      activity: () => level,
      handlers: { sweep: every({ active: 30_000 }, sweep) },
    });

    await alarms.sweep(Date.now());
    await runNextOccurrence(storage, alarms);
    expect(sweep).toHaveBeenCalledTimes(1);

    level = 'inactive';
    await runNextOccurrence(storage, alarms);

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(readAlarms(storage)).toEqual([]);
    expect(storage.alarmAt).toBeNull();
  });

  it('falls back to the wildcard period and rounds jittered periods up', async () => {
    startClock();
    const storage = new FakeStorage();

    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      activity: (): Level => 'inactive',
      handlers: {
        snapshot: every({ '*': 3_600_000 }, () => undefined),
        heartbeat: every(
          () => 1_000.25,
          () => undefined
        ),
      },
    });

    const start = Date.now();
    await alarms.snapshot(start);
    await alarms.heartbeat(start);
    await runNextOccurrence(storage, alarms);

    expect(
      readAlarms(storage).map(({ name, next_attempt_at }) => ({
        name,
        next_attempt_at,
      }))
    ).toEqual([
      { name: 'heartbeat', next_attempt_at: start + 1_001 },
      { name: 'snapshot', next_attempt_at: start + 3_600_000 },
    ]);
  });

  it('raises activity by moving occurrences earlier, never later', async () => {
    startClock();
    const storage = new FakeStorage();
    const events: DurabilityAlarmEvent[] = [];

    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      activity: (): Level => 'inactive',
      handlers: {
        heartbeat: every(
          { active: 30_000, inactive: 21_600_000 },
          () => undefined
        ),
        sweep: every({ active: 30_000 }, () => undefined),
        soon: every({ active: 30_000 }, () => undefined),
        snapshot: every({ inactive: 3_600_000 }, () => undefined),
      },
    });

    alarms.lifecycle((event) => {
      events.push(event);
    });

    const start = Date.now();
    await alarms.heartbeat(start + 21_600_000);
    await alarms.soon(start + 1_000);
    const before = readAlarms(storage);
    events.length = 0;

    await alarms.raiseActivity('active');

    const after = readAlarms(storage);
    expect(
      after.map(({ name, next_attempt_at }) => [name, next_attempt_at])
    ).toEqual([
      ['heartbeat', start + 30_000],
      ['soon', start + 1_000],
      ['sweep', start + 30_000],
    ]);
    expect(after[0]?.generation_id).toBe(before[0]?.generation_id);
    expect(
      events.map((event) => event.type === 'scheduled' && event.alarm)
    ).toEqual(['heartbeat', 'sweep']);
  });

  it('leaves an occurrence waiting to retry at its retry time', async () => {
    startClock();
    const storage = new FakeStorage();

    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      activity: (): Level => 'active',
      handlers: {
        sweep: every(
          { active: 30_000 },
          () => {
            throw new Error('sweep unavailable');
          },
          { retries: { delay: () => 60_000, maxAttempts: 3 } }
        ),
      },
    });

    const start = Date.now();
    await alarms.sweep(start);
    await runNextOccurrence(storage, alarms);
    await alarms.raiseActivity('active');

    expect(readAlarms(storage)).toEqual([
      expect.objectContaining({ attempt: 1, next_attempt_at: start + 60_000 }),
    ]);
  });

  it('keeps its cadence after an occurrence fails for good', async () => {
    startClock();
    const storage = new FakeStorage();
    const events: DurabilityAlarmEvent[] = [];
    let failures = 0;

    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      activity: (): Level => 'active',
      handlers: {
        sweep: every(
          { active: 30_000 },
          () => {
            failures += 1;
            throw new Error('sweep unavailable');
          },
          { retries: { delay: () => 0, maxAttempts: 2 } }
        ),
      },
    });

    alarms.lifecycle((event) => {
      events.push(event);
    });

    const start = Date.now();
    await alarms.sweep(start);
    await runNextOccurrence(storage, alarms);
    const failedGeneration = readAlarms(storage)[0]?.generation_id;
    await runNextOccurrence(storage, alarms);

    expect(failures).toBe(2);
    expect(readAlarms(storage)).toEqual([
      expect.objectContaining({
        status: 'pending',
        attempt: 0,
        next_attempt_at: start + 30_000,
      }),
    ]);
    expect(readAlarms(storage)[0]?.generation_id).not.toBe(failedGeneration);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'attempt_settled', outcome: 'failed' })
    );
    expect(events[events.length - 1]).toEqual(
      expect.objectContaining({
        type: 'scheduled',
        alarm: 'sweep',
        scheduledTime: start + 30_000,
      })
    );
  });

  it('lets a replacement scheduled during a run win over the next occurrence', async () => {
    startClock();
    const storage = new FakeStorage();
    const { alarms, start, finish, pass } = await startBlockedSweep(storage);

    await alarms.sweep(start + 120_000);
    finish();
    await pass;

    expect(readAlarms(storage)).toEqual([
      expect.objectContaining({ attempt: 0, next_attempt_at: start + 120_000 }),
    ]);
  });

  it('stops recurring once cancelled during a run', async () => {
    startClock();
    const storage = new FakeStorage();
    const { alarms, finish, pass } = await startBlockedSweep(storage);

    await alarms.sweep.cancel();
    finish();
    await pass;

    expect(readAlarms(storage)).toEqual([]);
  });

  it('rejects options set in both every() and methods', () => {
    expect(
      () =>
        new DurabilityAlarms({
          context: contextFor(new FakeStorage()),
          handlers: {
            tick: every(60_000, () => undefined, { attemptTimeoutMs: 1_000 }),
          },
          methods: { tick: { attemptTimeoutMs: 2_000 } },
        })
    ).toThrow('Named alarm "tick" sets options in both every() and methods');
  });

  it('rejects periods that are not positive', () => {
    expect(() => every(0, () => undefined)).toThrow(RangeError);
    expect(() => every({ active: -1 }, () => undefined)).toThrow(RangeError);
  });
});
