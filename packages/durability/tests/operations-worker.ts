import { DurableObject } from 'cloudflare:workers';
import { Durability, type DurableCall } from '../src';

export class OperationsTestObject extends DurableObject {
  private readonly durability = new Durability({
    context: this.ctx,
    handlers: {
      work: async ({ payload }: DurableCall<number>) => payload * 2,
    },
  });

  /**
   * Registers `count` operations, drives them to completion, then prunes them
   * in a single call whose `limit` exceeds the 100 bound-parameter cap a naive
   * id list would hit on a Durable Object's SQLite.
   */
  async seedAndPrune(count: number, limit: number): Promise<number> {
    for (let i = 0; i < count; i += 1) {
      await this.durability.work({ id: `op-${i}`, payload: i });
    }
    await this.#drainToCompletion(count);

    return this.durability.prune({ completedBefore: Date.now() + 1, limit });
  }

  getResult(id: string) {
    return this.durability.work.getResult(id);
  }

  async #drainToCompletion(count: number): Promise<void> {
    for (let pass = 0; pass < 20; pass += 1) {
      await this.durability.alarm();
      const last = await this.durability.work.getResult(`op-${count - 1}`);
      if (last.status === 'completed') {
        return;
      }
    }
    throw new Error('operations did not complete');
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }
}
