import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { OperationsTestObject } from './operations-worker';

declare global {
  namespace Cloudflare {
    interface Env {
      OPERATIONS_TEST: DurableObjectNamespace<OperationsTestObject>;
    }
  }
}

describe('Durability.prune on Durable Object SQLite', () => {
  it('prunes more than 100 records in one call', async () => {
    const stub = env.OPERATIONS_TEST.get(env.OPERATIONS_TEST.newUniqueId());

    // A naive id list would bind over 100 parameters here and fail; the move
    // and delete must use a fixed number of bound parameters instead.
    const count = 150;
    await expect(stub.seedAndPrune(count, count)).resolves.toBe(count);

    await expect(stub.getResult('op-0')).resolves.toEqual({
      status: 'pruned',
      outcome: 'completed',
    });
    await expect(stub.getResult(`op-${count - 1}`)).resolves.toEqual({
      status: 'pruned',
      outcome: 'completed',
    });
  });
});
