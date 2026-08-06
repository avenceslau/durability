import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Durability,
  DurabilityAlarms,
  DurabilityFanout,
  DurabilityScheduler,
  FanoutSettlementError,
  type DurabilityFanoutMessage,
} from './index';
import type { StoredMessage } from './stored-message';
import type { FanoutTarget } from './fanout';
import { RoutingLoad } from './load';
import { RoutingClient } from './routing-client';
import { FakeKvStorage, FakeStorage } from './test-fakes';

/** A destination is just a write function; this one records what it received. */
class Sink {
  readonly entries = new Map<string, StoredMessage<string>>();
  fail = false;

  readonly write = async (entry: StoredMessage<string>): Promise<void> => {
    if (this.fail) {
      throw new Error('sink unavailable');
    }
    this.entries.set(entry.id, entry);
  };

  remove(id: string): void {
    this.entries.delete(id);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

for (const backend of ['sqlite', 'kv'] as const) {
  describe(`fanout ${backend}`, () => {
    const fixture = (
      targets: Record<string, FanoutTarget<string>>,
      sink = new Sink()
    ) => {
      const storage =
        backend === 'sqlite' ? new FakeStorage() : new FakeKvStorage();
      const routing = new RoutingLoad();
      const config = {
        context: { storage: storage as unknown as DurableObjectStorage },
        storageBackend: backend,
        targets,
        routing,
        dlq: sink.write,
        retries: { maxAttempts: 2, delay: () => 1_000 },
      };
      return {
        storage,
        routing,
        sink,
        config,
        fanout: new DurabilityFanout(config),
      };
    };

    it('returns durable acceptance and load, with independent per-target outcomes', async () => {
      const a = vi.fn(async (messages: DurabilityFanoutMessage<string>[]) => {
        await Promise.all(messages.map((m) => m.ack()));
      });
      const b = vi.fn(async () => undefined);
      const { fanout, sink } = fixture({
        a: { deliver: a },
        b: { deliver: b },
      });
      const result = await fanout.enqueue([
        { id: 'one', body: '1' },
        { id: 'two', body: '2' },
      ]);
      expect(result).toMatchObject({
        success: true,
        value: ['one', 'two'],
        load: { inbound: { completed: 1 }, outbound: { pendingDeliveries: 4 } },
      });
      await fanout.alarm();
      expect((await fanout.load()).outbound.pendingDeliveries).toBe(2);
      vi.advanceTimersByTime(1_000);
      await fanout.alarm();
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(2);
      expect(
        [...sink.entries.values()].map((entry) => [
          entry.messageId,
          entry.target,
          entry.attempts,
        ])
      ).toEqual([
        ['one', 'b', 2],
        ['two', 'b', 2],
      ]);
      expect((await fanout.load()).outbound.pendingDeliveries).toBe(0);
    });

    it('deduplicates against the original recipients while siblings remain pending', async () => {
      const delivered: string[] = [];
      const { fanout, config } = fixture({
        fast: {
          deliver: async (messages) => {
            delivered.push(...messages.map((m) => m.id));
            await Promise.all(messages.map((m) => m.ack()));
          },
        },
        slow: { deliver: async () => undefined },
      });
      await fanout.enqueue({ id: 'same', body: 'payload' });
      await fanout.alarm();
      const recreated = new DurabilityFanout(config);
      await expect(
        recreated.enqueue({ id: 'same', body: 'payload' })
      ).resolves.toMatchObject({ success: true });
      await recreated.alarm();
      expect(delivered).toEqual(['same']);
      expect((await recreated.load()).outbound.pendingDeliveries).toBe(1);
    });

    it('rolls back every message when a later item conflicts', async () => {
      const deliver = vi.fn(async () => undefined);
      const { fanout } = fixture({ one: { deliver } });
      await fanout.enqueue({ id: 'existing', body: 'original' });
      await fanout.alarm();
      const result = await fanout.enqueue([
        { id: 'new', body: 'first' },
        { id: 'existing', body: 'different' },
      ]);
      expect(result).toMatchObject({
        success: false,
        error: { name: 'FanoutEnqueueError' },
      });
      expect(result.load.outbound.pendingDeliveries).toBe(1);
      await expect(
        fanout.enqueue({ body: 'x' }, { targets: ['missing'] })
      ).resolves.toMatchObject({ success: false });
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    it('retains removed targets and does not deliver old messages to newly configured ones', async () => {
      const { fanout, config } = fixture({
        removed: { deliver: async () => undefined },
      });
      await fanout.enqueue({ id: 'old', body: 'x' });
      await fanout.alarm();
      const added = vi.fn(async () => undefined);
      const recreated = new DurabilityFanout({
        ...config,
        targets: { added: { deliver: added } },
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.advanceTimersByTime(1_000);
      await recreated.alarm();
      expect(added).not.toHaveBeenCalled();
      expect((await recreated.load()).outbound.pendingDeliveries).toBe(1);
    });

    it('lets a healthy target complete while another target is still awaiting a consumer', async () => {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const healthy = vi.fn(
        async (messages: DurabilityFanoutMessage<string>[]) => {
          await Promise.all(messages.map((m) => m.ack()));
        }
      );
      const { fanout } = fixture({
        slow: { deliver: () => gate },
        healthy: { deliver: healthy },
      });
      await fanout.enqueue({ body: 'x' });
      await vi.waitFor(() => expect(healthy).toHaveBeenCalledOnce());
      await vi.waitFor(async () =>
        expect((await fanout.load()).outbound.pendingDeliveries).toBe(1)
      );
      expect((await fanout.load()).outbound.inFlight).toBe(1);
      finish();
      await fanout.alarm();
    });

    it('uses storage as an ordinary target and retries writes before acknowledging', async () => {
      const write = vi.fn(async (_message: StoredMessage<string>) => {
        if (write.mock.calls.length === 1) {
          throw new Error('storage failed');
        }
      });
      const { fanout } = fixture({ archive: { storage: write } });
      await fanout.enqueue({ id: 'stored', body: 'x' });
      await fanout.alarm();
      expect((await fanout.load()).outbound.pendingDeliveries).toBe(1);
      vi.advanceTimersByTime(1_000);
      await fanout.alarm();
      expect(write).toHaveBeenCalledTimes(2);
      // The delivery identity is stable, so an idempotent destination keyed by
      // it collapses the retry; only the attempt bookkeeping advances.
      const [first, second] = write.mock.calls.map(([message]) => message);
      expect(second?.id).toBe(first?.id);
      expect([first?.attempts, second?.attempts]).toEqual([1, 2]);
      expect((await fanout.load()).outbound.pendingDeliveries).toBe(0);
    });

    it('keeps explicit dead-letter intent and target across an outage and restart', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const sink = new Sink();
      sink.fail = true;
      const deliver = vi.fn(
        async (messages: DurabilityFanoutMessage<string>[]) => {
          await Promise.all(messages.map((m) => m.deadLetter()));
        }
      );
      const { fanout, config } = fixture({ destination: { deliver } }, sink);
      await fanout.enqueue({ id: 'bad', body: 'bad' });
      await fanout.alarm();
      expect((await fanout.load()).outbound.pendingDeliveries).toBe(1);
      sink.fail = false;
      const recovered = new DurabilityFanout(config);
      vi.advanceTimersByTime(60_000);
      await recovered.alarm();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect([...sink.entries.values()]).toEqual([
        expect.objectContaining({
          messageId: 'bad',
          target: 'destination',
          failure: { reason: 'explicit', error: null },
          attempts: 1,
        }),
      ]);
      expect((await recovered.load()).outbound.pendingDeliveries).toBe(0);
    });

    it('redrives only the failed target through routing with a fresh attempt budget', async () => {
      const seen: Array<[string, number]> = [];
      let recover = false;
      const targets: Record<string, FanoutTarget<string>> = {
        a: {
          deliver: async (messages) => {
            seen.push(
              ...messages.map((m): [string, number] => ['a', m.attempt])
            );
            await Promise.all(messages.map((m) => m.ack()));
          },
        },
        b: {
          deliver: async (messages) => {
            seen.push(
              ...messages.map((m): [string, number] => ['b', m.attempt])
            );
            if (recover) {
              await Promise.all(messages.map((m) => m.ack()));
            }
          },
        },
      };
      const { fanout, sink } = fixture(targets);
      await fanout.enqueue({ id: 'redrive', body: 'x' });
      await fanout.alarm();
      vi.advanceTimersByTime(1_000);
      await fanout.alarm();
      const entry = [...sink.entries.values()][0]!;
      const other = fixture(targets);
      const sharding = vi.fn(() => 'different-shard');
      const router = new RoutingClient({
        sharding,
        invoke: async (_address, message: StoredMessage<string>) =>
          other.fanout.enqueue(
            {
              id: message.messageId,
              body: message.body,
              deduplicationKey: message.id,
            },
            { targets: [message.target] }
          ),
      });
      recover = true;
      const accepted = await router.push(entry);
      if (accepted.success) {
        sink.remove(entry.id);
      }
      await other.fanout.alarm();
      expect(sharding).toHaveBeenCalledOnce();
      expect(seen).toEqual([
        ['a', 1],
        ['b', 1],
        ['b', 2],
        ['b', 1],
      ]);
      expect(sink.entries.size).toBe(0);
    });

    it('supports retry(10), throws on duplicate settlement, and invalidates late capabilities', async () => {
      const captured: DurabilityFanoutMessage<string>[] = [];
      const { fanout, storage } = fixture({
        one: {
          deliver: async (messages) => {
            captured.push(...messages);
            await Promise.all(messages.map((m) => m.retry(10)));
          },
        },
      });
      await fanout.enqueue({ id: 'one', body: 'x' });
      await fanout.alarm();
      await expect(captured[0]!.ack()).rejects.toBeInstanceOf(
        FanoutSettlementError
      );
      expect(storage.alarmAt).toBe(Date.now() + 15_000);
      await vi.advanceTimersByTimeAsync(9);
      expect(captured).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(captured).toHaveLength(2));
    });

    it('prioritizes unseen messages over immediately due retries', async () => {
      const seen: string[] = [];
      const { config } = fixture({
        one: {
          deliver: async (messages) => {
            seen.push(...messages.map((m) => `${m.id}:${m.attempt}`));
            await Promise.all(
              messages.map((m) => (m.id === 'a' ? m.retry(0) : m.ack()))
            );
          },
        },
      });
      const fanout = new DurabilityFanout({ ...config, maxBatchSize: 1 });
      await fanout.enqueue([
        { id: 'a', body: 'a' },
        { id: 'b', body: 'b' },
      ]);
      await fanout.alarm();
      await fanout.alarm();
      await fanout.alarm();
      expect(seen).toEqual(['a:1', 'b:1', 'a:2']);
    });

    it('bounds a timed-out batch, reports its duration, and rejects late settlement', async () => {
      const captured: DurabilityFanoutMessage<string>[] = [];
      const { config } = fixture({
        slow: {
          deliver: (messages) => {
            captured.push(...messages);
            return new Promise(() => undefined);
          },
        },
      });
      const fanout = new DurabilityFanout({ ...config, attemptTimeoutMs: 25 });
      await fanout.enqueue({ body: 'slow' });
      const running = fanout.alarm();
      await vi.advanceTimersByTimeAsync(25);
      await running;
      await expect(captured[0]!.ack()).rejects.toBeInstanceOf(
        FanoutSettlementError
      );
      expect((await fanout.load()).outbound).toEqual({
        completed: 1,
        inFlight: 0,
        averageProcessingMs: 25,
        pendingDeliveries: 1,
      });
    });

    it('awaits a started ack even when the consumer throws afterwards', async () => {
      const { storage, config } = fixture({
        target: { deliver: async () => undefined },
      });
      const transact = storage.transaction.bind(storage);
      const fanout = new DurabilityFanout({
        ...config,
        targets: {
          target: {
            deliver: async (messages) => {
              vi.spyOn(storage, 'transaction').mockImplementationOnce(
                async (callback) => {
                  await new Promise((resolve) => setTimeout(resolve, 20));
                  return transact(callback);
                }
              );
              void messages[0]!.ack();
              throw new Error('later message failed');
            },
          },
        },
      });
      await fanout.enqueue([
        { id: 'a', body: 'a' },
        { id: 'b', body: 'b' },
      ]);
      const running = fanout.alarm();
      await vi.advanceTimersByTimeAsync(19);
      expect((await fanout.load()).outbound.inFlight).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await running;
      expect((await fanout.load()).outbound).toMatchObject({
        inFlight: 0,
        pendingDeliveries: 1,
        averageProcessingMs: 20,
      });
    });

    it('does not fail fast while a sibling storage write is still completing', async () => {
      const { config } = fixture({
        target: { deliver: async () => undefined },
      });
      const fanout = new DurabilityFanout({
        ...config,
        targets: {
          archive: {
            storage: async (message) => {
              if (message.messageId === 'bad') {
                throw new Error('write failed');
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            },
          },
        },
      });
      await fanout.enqueue([
        { id: 'slow', body: 'slow' },
        { id: 'bad', body: 'bad' },
      ]);
      const running = fanout.alarm();
      await vi.advanceTimersByTimeAsync(19);
      expect((await fanout.load()).outbound.inFlight).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await running;
      expect((await fanout.load()).outbound).toMatchObject({
        pendingDeliveries: 1,
        averageProcessingMs: 20,
      });
    });

    it('does not represent uncertain storage failures as definite rejection', async () => {
      const { fanout, storage } = fixture({
        target: { deliver: async () => undefined },
      });
      vi.spyOn(storage, 'transaction').mockRejectedValueOnce(
        new Error('storage unavailable')
      );
      await expect(fanout.enqueue({ body: 'x' })).rejects.toThrow(
        'storage unavailable'
      );
      expect((await fanout.load()).inbound).toMatchObject({
        inFlight: 0,
        completed: 1,
      });
    });

    it('returns rejection before writing any unserializable batch', async () => {
      const deliver = vi.fn(async () => undefined);
      const { fanout } = fixture({ target: { deliver } });
      const invalid = {
        id: 'bad',
        body: (() => undefined) as unknown as string,
      };
      expect(
        await fanout.enqueue([{ id: 'good', body: 'good' }, invalid])
      ).toMatchObject({ success: false });
      expect((await fanout.load()).outbound.pendingDeliveries).toBe(0);
      expect(deliver).not.toHaveBeenCalled();
    });

    it('shares a physical alarm with existing operations and named alarms', async () => {
      const storage =
        backend === 'sqlite' ? new FakeStorage() : new FakeKvStorage();
      const scheduler = new DurabilityScheduler({
        context: { storage: storage as unknown as DurableObjectStorage },
        storageBackend: backend,
      });
      const fanout = new DurabilityFanout<string>({
        scheduler,
        targets: {
          target: {
            deliver: async (messages) => {
              await Promise.all(messages.map((m) => m.ack()));
            },
          },
        },
      });
      const handler = vi.fn(async () => 'done');
      const operations = new Durability({
        scheduler,
        handlers: { work: handler },
      });
      const alarmHandler = vi.fn(async () => undefined);
      const alarms = new DurabilityAlarms({
        scheduler,
        handlers: { cleanup: alarmHandler },
      });
      await alarms.cleanup(Date.now() + 10);
      await fanout.enqueue({ body: 'message' });
      await operations.work({ id: 'work', payload: undefined });
      await scheduler.alarm();
      vi.advanceTimersByTime(10);
      await scheduler.alarm();
      expect(handler).toHaveBeenCalledOnce();
      expect(alarmHandler).toHaveBeenCalledOnce();
      expect((await fanout.load()).outbound.pendingDeliveries).toBe(0);
      expect(storage.alarmAt).toBeNull();
    });
  });
}
