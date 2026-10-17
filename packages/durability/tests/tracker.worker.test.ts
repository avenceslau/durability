import { env } from 'cloudflare:workers';
import { newWebSocketRpcSession } from 'capnweb';
import { describe, expect, it } from 'vitest';
import type { TrackerApi, TrackerTestObject } from './tracker-worker';

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
});
