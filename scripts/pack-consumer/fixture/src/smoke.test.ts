import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { SmokeObject } from './worker';

declare global {
  namespace Cloudflare {
    interface Env {
      SMOKE: DurableObjectNamespace<SmokeObject>;
    }
  }
}

const waitFor = async (
  assertion: () => Promise<void>,
  remaining = 60
): Promise<void> => {
  try {
    await assertion();
  } catch (error) {
    if (remaining === 0) {
      throw error;
    }
    await scheduler.wait(5);
    await waitFor(assertion, remaining - 1);
  }
};

describe('packed durability smoke', () => {
  it('runs an immediate successful operation and reads its result', async () => {
    const stub = env.SMOKE.get(env.SMOKE.newUniqueId());
    await stub.runSucceed(21);
    await waitFor(async () => {
      expect(await stub.succeedResult(21)).toEqual({
        status: 'completed',
        result: 42,
      });
    });
  });

  it('retries a failed operation from an alarm and completes', async () => {
    const stub = env.SMOKE.get(env.SMOKE.newUniqueId());
    await stub.runFlaky();
    await waitFor(async () => {
      expect(await stub.flakyResult()).toEqual({
        status: 'completed',
        result: 2,
      });
    });
    expect(await stub.flakyAttempts()).toEqual([1, 2]);
  });

  it('fires a named alarm with a stable idempotency key', async () => {
    const stub = env.SMOKE.get(env.SMOKE.newUniqueId());
    await stub.schedulePing(Date.now() + 20);
    await waitFor(async () => {
      expect(await stub.pingKey()).toMatch(/^durability-alarm:v1:/);
    });
  });
});
