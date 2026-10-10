import { exports as workerExports } from 'cloudflare:workers';
import { evictDurableObject } from 'cloudflare:test';
import { scheduler } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { KvLogTestObject, LogTestObject } from './log-worker';

const namespaceFor = (name: string) => {
  const candidate = (workerExports as Record<string, unknown>)[name];
  if (
    (typeof candidate !== 'object' && typeof candidate !== 'function') ||
    candidate === null ||
    !('getByName' in candidate)
  ) {
    throw new Error(`Loopback namespace "${name}" is unavailable`);
  }
  return candidate as DurableObjectNamespace<LogTestObject | KvLogTestObject>;
};

for (const [label, className] of [
  ['sqlite', 'LogTestObject'],
  ['kv', 'KvLogTestObject'],
] as const) {
  describe(`durable log ${label}`, () => {
    const objectFor = (name: string) => namespaceFor(className).getByName(name);

    it('retains records across eviction so a consumer replays history', async () => {
      const name = crypto.randomUUID();
      const stub = objectFor(name);
      const appended = await stub.append([
        { body: { topic: 'a', value: 1 } },
        { body: { topic: 'b', value: 2 } },
      ]);
      expect(appended).toMatchObject({ success: true, value: [0, 1] });

      await stub.commit('search', 2);
      await evictDurableObject(stub);

      const revived = objectFor(name);
      expect(await revived.cursors()).toEqual({ search: 2 });
      const page = await revived.read(0);
      expect(page.records.map((record) => record.body.topic)).toEqual([
        'a',
        'b',
      ]);
      expect(page).toMatchObject({ nextOffset: 2, lag: 0 });
    });

    it('keeps offsets monotonic and deduplicates a repeated append', async () => {
      const stub = objectFor(crypto.randomUUID());
      const first = await stub.append([
        { deduplicationKey: 'k1', body: { topic: 'a', value: 1 } },
      ]);
      const repeat = await stub.append([
        { deduplicationKey: 'k1', body: { topic: 'a', value: 1 } },
        { deduplicationKey: 'k2', body: { topic: 'b', value: 2 } },
      ]);
      expect(first).toMatchObject({ success: true, value: [0] });
      expect(repeat).toMatchObject({ success: true, value: [0, 1] });
      expect(await stub.bounds()).toEqual({
        oldestOffset: 0,
        hotOffset: 0,
        nextOffset: 2,
      });
    });

    it('flushes to R2 beyond retention and rehydrates a late reader', async () => {
      const stub = objectFor(crypto.randomUUID());
      await stub.append(
        [1, 2, 3, 4, 5].map((value) => ({ body: { topic: 'a', value } }))
      );
      // The object retains three records; the rest move to R2.
      expect(await stub.trim()).toBe(2);
      expect(await stub.bounds()).toEqual({
        oldestOffset: 0,
        hotOffset: 2,
        nextOffset: 5,
      });

      // Offset 0 now lives only in R2, and reading it fetches it back.
      const rehydrated = await stub.read(0, 2);
      expect(rehydrated.records.map((record) => record.body.value)).toEqual([
        1, 2,
      ]);
      expect((await stub.read(rehydrated.nextOffset)).records).toHaveLength(3);

      // Forgetting the segment is how an R2 lifecycle rule is mirrored.
      expect(await stub.forgetColdBefore(2)).toBe(1);
      // Wrapped so the RPC rejection is consumed inside the assertion.
      await expect(async () => {
        await stub.read(0);
      }).rejects.toThrow(/was trimmed/);
      expect((await stub.read(2)).records).toHaveLength(3);
    });

    it('leases distinct ranges and survives eviction mid-flight', async () => {
      const name = crypto.randomUUID();
      const stub = objectFor(name);
      await stub.append(
        [1, 2, 3].map((value) => ({ body: { topic: 'a', value } }))
      );

      const first = await stub.lease('search', 1);
      const second = await stub.lease('search', 1);
      expect(first?.firstOffset).toBe(0);
      expect(second?.firstOffset).toBe(1);
      // Both ranges are held, so a third poller gets nothing.
      expect(await stub.lease('search', 1)).toBeUndefined();

      await evictDurableObject(stub);
      const revived = objectFor(name);
      // Leases are durable, so eviction does not hand offset 0 to anyone else.
      expect(await revived.lease('search', 1)).toBeUndefined();

      // The later range acking first must not commit past the earlier one.
      await revived.ackLease('search', second!.batchId);
      expect(await revived.cursor('search')).toBeUndefined();
      await revived.ackLease('search', first!.batchId);
      expect(await revived.cursor('search')).toBe(2);
    });

    it('fences the previous holder once a lease expires', async () => {
      const stub = objectFor(crypto.randomUUID());
      await stub.append([{ body: { topic: 'a', value: 1 } }]);
      const held = await stub.lease('search', 1);

      await scheduler.wait(1_100);
      const stolen = await stub.lease('search', 1);
      expect(stolen).toMatchObject({ firstOffset: 0, attempt: 2 });

      await expect(async () => {
        await stub.ackLease('search', held!.batchId);
      }).rejects.toThrow(/is not held/);
      await stub.ackLease('search', stolen!.batchId);
      expect(await stub.cursor('search')).toBe(1);
    });

    it('reports backlog from the furthest-behind consumer', async () => {
      const stub = objectFor(crypto.randomUUID());
      await stub.append(
        [1, 2, 3].map((value) => ({ body: { topic: 'a', value } }))
      );
      await stub.commit('fast', 3);
      await stub.commit('slow', 1);
      expect((await stub.load()).outbound.pendingDeliveries).toBe(2);
    });
  });
}
