import { exports as workerExports } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { OutboxObject } from './outbox-worker';

const namespace = (workerExports as Record<string, unknown>)[
  'OutboxObject'
] as DurableObjectNamespace<OutboxObject>;

describe('outbox in workerd', () => {
  it('commits and rolls back with the application transaction', async () => {
    const stub = namespace.getByName(crypto.randomUUID());

    expect(await stub.set('a', 1)).toBe(true);
    expect(await stub.set('b', 2, true)).toBe(false);
    expect(await stub.counters()).toEqual([{ key: 'a', value: 1 }]);

    await runDurableObjectAlarm(stub);
    await expect.poll(() => stub.published()).toEqual([{ key: 'a', value: 1 }]);
    expect(await stub.pending()).toEqual([]);
  });
});
