import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DurabilityOutbox,
  DurabilityScheduler,
  type DurabilityLifecycleEvent,
  type OutboxEntry,
} from './index';
import { FakeStorage } from './test-fakes';

type Published = Pick<OutboxEntry<string>, 'key' | 'version' | 'value'>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const published = (entries: OutboxEntry<string>[]): Published[] =>
  entries.map(({ key, version, value }) => ({ key, version, value }));

describe('outbox', () => {
  const fixture = () => {
    const storage = new FakeStorage();
    const scheduler = new DurabilityScheduler({
      context: { storage: storage as unknown as DurableObjectStorage },
    });
    return { storage, scheduler };
  };

  it('publishes only the newest staged version of each key', async () => {
    const { scheduler } = fixture();
    const publish = vi.fn(async (_entries: OutboxEntry<string>[]) => {});
    const outbox = new DurabilityOutbox<string>({ scheduler, publish });

    const first = await outbox.stage('a', 'one');
    const second = await outbox.stage('a', 'two');
    await outbox.stage('b', 'other');
    await outbox.alarm();

    expect(second).toBeGreaterThan(first);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(published(publish.mock.calls[0]![0])).toEqual([
      { key: 'a', version: second, value: 'two' },
      { key: 'b', version: second + 1, value: 'other' },
    ]);

    await outbox.alarm();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('keeps versions monotonic after acknowledged rows are deleted', async () => {
    const { scheduler } = fixture();
    const outbox = new DurabilityOutbox<string>({
      scheduler,
      publish: () => undefined,
    });

    const first = await outbox.stage('a', 'one');
    await outbox.alarm();
    const second = await outbox.stage('a', 'two');

    expect(second).toBeGreaterThan(first);
  });

  it('does not let an in-flight acknowledgement discard a newer stage', async () => {
    const { scheduler } = fixture();
    let release!: () => void;
    const calls: Published[][] = [];
    const outbox = new DurabilityOutbox<string>({
      scheduler,
      publish: async (entries) => {
        calls.push(published(entries));
        if (calls.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
    });

    await outbox.stage('a', 'one');
    const running = outbox.alarm();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const newer = await outbox.stage('a', 'two');
    release();
    await running;
    await outbox.alarm();

    expect(calls).toEqual([
      [{ key: 'a', version: newer - 1, value: 'one' }],
      [{ key: 'a', version: newer, value: 'two' }],
    ]);
  });

  it('retries a failed batch with the configured delay until acknowledged', async () => {
    const { scheduler } = fixture();
    const events: DurabilityLifecycleEvent[] = [];
    const attempts: number[] = [];
    const outbox = new DurabilityOutbox<string>({
      scheduler,
      retries: { delay: () => 5_000 },
      onLifecycleEvent: (event) => {
        events.push(event);
      },
      publish: (entries) => {
        attempts.push(entries[0]!.attempt);
        if (attempts.length === 1) {
          throw new Error('sink unavailable');
        }
      },
    });

    await outbox.stage('a', 'one');
    await outbox.alarm();
    await outbox.alarm();
    expect(attempts).toEqual([1]);

    vi.advanceTimersByTime(5_000);
    await outbox.alarm();
    expect(attempts).toEqual([1, 2]);
    expect(
      events.map((event) =>
        event.type === 'attempt_settled' ? event.outcome : event.type
      )
    ).toEqual([
      'registered',
      'attempt_started',
      'retry_scheduled',
      'attempt_started',
      'completed',
    ]);
  });

  it('publishes only the newer version after a timed-out publication of the older one', async () => {
    const { scheduler } = fixture();
    let releaseFirst!: () => void;
    const sink = new Map<string, { version: number; value: string }>();
    const outbox = new DurabilityOutbox<string>({
      scheduler,
      attemptTimeoutMs: 1_000,
      retries: { delay: () => 0 },
      publish: async (entries) => {
        if (entries[0]!.version === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        for (const entry of entries) {
          const current = sink.get(entry.key);
          if (!current || current.version < entry.version) {
            sink.set(entry.key, {
              version: entry.version,
              value: entry.value,
            });
          }
        }
      },
    });

    await outbox.stage('a', 'one');
    const firstRun = outbox.alarm();
    await vi.advanceTimersByTimeAsync(1_000);
    await firstRun;
    await outbox.stage('a', 'two');
    await outbox.alarm();
    expect(sink.get('a')).toEqual({ version: 2, value: 'two' });

    // The timed-out publication completes late; a version-aware sink ignores it.
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.get('a')).toEqual({ version: 2, value: 'two' });
    await outbox.alarm();
    expect(sink.get('a')).toEqual({ version: 2, value: 'two' });
  });

  it('keeps a restaged key pending when the older attempt fails, and runs one batch at a time', async () => {
    const { scheduler } = fixture();
    let gate: (() => void) | undefined;
    const versions: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const outbox = new DurabilityOutbox<string>({
      scheduler,
      retries: { delay: () => 0 },
      publish: async (entries) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        try {
          if (gate === undefined) {
            await new Promise<void>((resolve) => {
              gate = resolve;
            });
            throw new Error('sink unavailable');
          }
          versions.push(...entries.map((entry) => entry.version));
        } finally {
          concurrent -= 1;
        }
      },
    });

    await outbox.stage('a', 'one');
    const failing = outbox.alarm();
    await vi.waitFor(() => expect(gate).toBeDefined());
    await outbox.stage('a', 'two');
    gate!();
    await failing;

    await Promise.all([outbox.alarm(), outbox.alarm(), outbox.alarm()]);
    expect(versions).toEqual([2]);
    expect(maxConcurrent).toBe(1);
  });
  it('retries only the entries the publisher marks', async () => {
    const { scheduler } = fixture();
    const seen: string[] = [];
    let escaped: OutboxEntry<string> | undefined;
    const outbox = new DurabilityOutbox<string>({
      scheduler,
      publish: (entries) => {
        for (const entry of entries) {
          seen.push(entry.key);
          if (entry.key === 'b' && entry.attempt === 1) {
            entry.retry(1_000);
          }
        }
        escaped = entries[0];
      },
    });

    await outbox.stage('a', 'one');
    await outbox.stage('b', 'two');
    await outbox.alarm();
    expect(() => escaped?.retry()).toThrow(/while publish is running/);

    vi.advanceTimersByTime(1_000);
    await outbox.alarm();
    expect(seen).toEqual(['a', 'b', 'b']);
  });

  it('retries a publication that exceeds its timeout', async () => {
    const { scheduler } = fixture();
    let calls = 0;
    const outbox = new DurabilityOutbox<string>({
      scheduler,
      attemptTimeoutMs: 1_000,
      retries: { delay: () => 0 },
      publish: () => {
        calls += 1;
        return calls === 1 ? new Promise(() => undefined) : undefined;
      },
    });

    await outbox.stage('a', 'one');
    const running = outbox.alarm();
    await vi.advanceTimersByTimeAsync(1_000);
    await running;
    await outbox.alarm();

    expect(calls).toBe(2);
  });

  it('partitions channels that share one scheduler', async () => {
    const { scheduler } = fixture();
    const left = vi.fn((_entries: OutboxEntry<string>[]) => undefined);
    const right = vi.fn((_entries: OutboxEntry<string>[]) => undefined);
    const a = new DurabilityOutbox<string>({
      scheduler,
      channel: 'left',
      publish: left,
    });
    const b = new DurabilityOutbox<string>({
      scheduler,
      channel: 'right',
      publish: right,
    });

    await a.stage('same', 'L');
    await b.stage('same', 'R');
    await scheduler.alarm();

    expect(published(left.mock.calls[0]![0])).toMatchObject([
      { key: 'same', value: 'L' },
    ]);
    expect(published(right.mock.calls[0]![0])).toMatchObject([
      { key: 'same', value: 'R' },
    ]);
    expect(
      () =>
        new DurabilityOutbox({
          scheduler,
          channel: 'left',
          publish: () => undefined,
        })
    ).toThrow(/already attached/);
  });

  it('retains and postpones entries of a channel that is no longer configured', async () => {
    const { storage, scheduler } = fixture();
    const removed = new DurabilityOutbox<string>({
      scheduler,
      channel: 'removed',
      publish: () => {
        throw new Error('unreachable');
      },
    });
    await removed.stage('a', 'one');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const restarted = new DurabilityScheduler({
      context: { storage: storage as unknown as DurableObjectStorage },
    });
    const publish = vi.fn(() => undefined);
    const kept = new DurabilityOutbox({
      scheduler: restarted,
      channel: 'kept',
      publish,
    });
    await kept.alarm();

    expect(publish).not.toHaveBeenCalled();
    expect(storage.alarmAt).toBe(Date.now() + 60_000);

    const recovered = vi.fn((_entries: OutboxEntry<string>[]) => undefined);
    const again = new DurabilityScheduler({
      context: { storage: storage as unknown as DurableObjectStorage },
    });
    const reattached = new DurabilityOutbox({
      scheduler: again,
      channel: 'removed',
      publish: recovered,
    });
    // Moving the clock without running timers keeps the previous object's
    // in-memory early alarm from firing, as if that object had been evicted.
    vi.setSystemTime(Date.now() + 60_000);
    await reattached.alarm();
    expect(published(recovered.mock.calls[0]![0])).toMatchObject([
      { key: 'a', value: 'one' },
    ]);
  });

  it('holds first publication for the batch delay', async () => {
    const { scheduler } = fixture();
    const publish = vi.fn((_entries: OutboxEntry<string>[]) => undefined);
    const outbox = new DurabilityOutbox<string>({
      scheduler,
      batchDelayMs: 10_000,
      publish,
    });

    vi.setSystemTime(Date.now() + 1);
    await outbox.stage('a', 'one');
    await outbox.alarm();
    expect(publish).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 9_999);
    await outbox.alarm();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid configuration and keys', async () => {
    const { scheduler } = fixture();
    expect(
      () =>
        new DurabilityOutbox({
          scheduler,
          channel: '',
          publish: () => undefined,
        })
    ).toThrow(TypeError);
    expect(
      () =>
        new DurabilityOutbox({
          scheduler,
          maxBatchSize: 0,
          publish: () => undefined,
        })
    ).toThrow(RangeError);
    const outbox = new DurabilityOutbox({
      scheduler,
      publish: () => undefined,
    });
    await expect(outbox.stage('', 'value')).rejects.toThrow(TypeError);
  });
});
