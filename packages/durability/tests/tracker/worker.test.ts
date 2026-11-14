import { env } from 'cloudflare:workers';
import { newWebSocketRpcSession } from 'capnweb';
import { describe, expect, it } from 'vitest';
import type { TrackerApi, TrackerTestObject } from './worker';

declare global {
  namespace Cloudflare {
    interface Env {
      TRACKER_TEST: DurableObjectNamespace<TrackerTestObject>;
    }
  }
}

const waitFor = async (
  assertion: () => Promise<void>,
  remaining = 40
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

const release = (stub: DurableObjectStub<TrackerTestObject>, id: string) =>
  waitFor(async () => {
    expect(await stub.release(id)).toBe(true);
  });

describe('DurabilityTracker over RPC', () => {
  it('lists handles and waits over Workers RPC', async () => {
    const stub = env.TRACKER_TEST.get(env.TRACKER_TEST.newUniqueId());
    await stub.start('job-1', 2);

    const { items } = await stub.listWork();
    expect(items).toMatchObject([
      {
        source: 'jobs',
        id: 'job-1',
        name: 'resize',
        state: { status: 'pending' },
      },
    ]);
    const [item] = items;
    if (!item) {
      throw new Error('Expected a tracked job');
    }
    const waiting = item.wait({ timeoutMs: 5_000 });
    await release(stub, 'job-1');

    await expect(waiting).resolves.toEqual({ status: 'completed', result: 4 });
  });

  it('pipelines wait onto a returned handle', async () => {
    const stub = env.TRACKER_TEST.get(env.TRACKER_TEST.newUniqueId());

    const waiting = stub.startAndTrack('job-2', 3).wait({ timeoutMs: 5_000 });
    await release(stub, 'job-2');

    await expect(waiting).resolves.toEqual({ status: 'completed', result: 6 });
  });

  it("lists handles and waits over Cap'n Web", async () => {
    const stub = env.TRACKER_TEST.get(env.TRACKER_TEST.newUniqueId());
    await stub.start('job-3', 5);
    const response = await stub.fetch('https://tracker.test/rpc', {
      headers: { Upgrade: 'websocket' },
    });
    const socket = response.webSocket;
    if (!socket) {
      throw new Error('Expected a WebSocket upgrade');
    }
    socket.accept();
    using api = newWebSocketRpcSession<TrackerApi>(socket);

    const { items } = await api.listWork();
    const [item] = items;
    if (!item) {
      throw new Error('Expected a tracked job');
    }
    expect(item).toMatchObject({ source: 'jobs', id: 'job-3' });
    const waiting = item.wait({ timeoutMs: 5_000 });
    await release(stub, 'job-3');

    await expect(waiting).resolves.toEqual({ status: 'completed', result: 10 });
  });

  it('holds more waits open than the runtime allows native timers', async () => {
    const stub = env.TRACKER_TEST.get(env.TRACKER_TEST.newUniqueId());
    await stub.start('job-4', 1);

    // workerd rejects setTimeout once 10,000 timers are pending.
    const startedAt = Date.now();
    await expect(stub.waitManyTimes('job-4', 12_000, 200)).resolves.toBe(
      12_000
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);

    await release(stub, 'job-4');
  });

  it('keeps later waits on time while every other native timer is taken', async () => {
    const stub = env.TRACKER_TEST.get(env.TRACKER_TEST.newUniqueId());
    await stub.start('job-6', 1);

    const { otherTimers, statuses } =
      await stub.waitTwiceWithNoNativeTimerLeft('job-6');

    expect(otherTimers).toBeGreaterThan(9_000);
    expect(statuses).toEqual(['pending', 'pending']);

    await release(stub, 'job-6');
  });

  it('settles that many waits at once before their timeouts', async () => {
    const stub = env.TRACKER_TEST.get(env.TRACKER_TEST.newUniqueId());
    await stub.start('job-5', 1);

    const stillPending = stub.waitManyTimes('job-5', 12_000, 60_000);
    await release(stub, 'job-5');

    await expect(stillPending).resolves.toBe(0);
  });
});
