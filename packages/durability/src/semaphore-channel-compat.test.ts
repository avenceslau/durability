import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SemaphoreProtocolError } from './errors';
import { DurabilitySemaphoreQueue } from './semaphore-queue';
import { semaphoreRequestSchema } from './semaphore-protocol';
import {
  DurabilitySemaphoreServer,
  type DurabilitySemaphoreEvent,
} from './semaphore-server';
import { contextFor, FakeStorage } from './test-fakes';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('does not leak leases when a previously acknowledged holder downgrades while idle', async () => {
  let limit = 1;
  let oldPeer = false;
  let rejected = 0;
  const holder = new DurabilitySemaphoreServer({
    context: contextFor(new FakeStorage()),
    limit: () => limit,
    roundWaitMs: 1,
    roundPeriodMs: 1,
    grantTimeoutMs: 1_000,
    leases: {
      provisioning: { mode: 'strict' },
      permitsPerLease: 2,
      ttlMs: 5_000,
    },
  });
  const admitted: string[] = [];
  const queue = new DurabilitySemaphoreQueue<string>({
    context: contextFor(new FakeStorage()),
    channel: 'library',
    clientId: 'same-object',
    retries: { delay: () => 100 },
    server: {
      request: async (_key, message) => {
        // Old holders require v1 and discard unknown fields before allocation.
        if (oldPeer && message.v !== 1) {
          rejected += 1;
          throw new SemaphoreProtocolError('Malformed semaphore message');
        }
        const { clientChannel: _ignored, ...legacy } = message;
        const reply = await holder.handle(oldPeer ? legacy : message);
        if (reply.type !== 'grant') {
          throw new Error('Expected grant response');
        }
        return reply;
      },
      sync: async (_key, message) => {
        if (oldPeer && message.v !== 1) {
          throw new SemaphoreProtocolError('Malformed semaphore message');
        }
        const { clientChannel: _ignored, ...legacy } = message;
        const reply = await holder.handle(oldPeer ? legacy : message);
        if (reply.type !== 'synced') {
          throw new Error('Expected sync response');
        }
        return reply;
      },
    },
    admit: (items) => {
      admitted.push(...items.map((item) => item.id));
    },
  });

  await queue.enqueue([{ id: 'first', key: 'holder', body: 'one' }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(admitted).toEqual(['first']);
  await queue.release('first');
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await holder.usage()).toMatchObject({ granted: 0, leased: 0 });

  // There is now spare lease capacity, but the peer no longer understands channels.
  oldPeer = true;
  limit = 4;
  await queue.enqueue([{ id: 'second', key: 'holder', body: 'two' }]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await holder.usage()).toMatchObject({ granted: 0, leased: 0 });
  expect(await queue.status('second')).toMatchObject({ state: 'queued' });
  expect(admitted).toEqual(['first']);
  expect(rejected).toBeGreaterThan(0);
});

it('requires both the response version and the channel to match', async () => {
  const sync = vi.fn(async () => ({
    type: 'synced' as const,
    v: 1 as const,
    clientChannel: 'library',
    grantResults: [],
  }));
  const queue = new DurabilitySemaphoreQueue({
    context: contextFor(new FakeStorage()),
    channel: 'library',
    clientId: 'client',
    server: {
      request: async () => ({
        type: 'grant',
        v: 1,
        clientChannel: 'library',
        grants: [
          {
            grantId: 'g',
            group: '',
            permits: 1,
          },
        ],
        blocked: [],
        nextRequestAt: Date.now() + 1_000,
        grantResults: [],
      }),
      sync,
    },
    admit: vi.fn(),
  });
  await queue.enqueue([{ id: 'a', key: 'holder', body: null }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(await queue.status('a')).toMatchObject({ state: 'queued' });
  expect(sync).not.toHaveBeenCalled();
});

it('preserves v1 requests and requires a channel for v2', () => {
  const legacy = {
    type: 'request',
    v: 1,
    clientId: 'client',
    demand: [],
    grants: [],
  };
  expect(semaphoreRequestSchema.parse(legacy)).toEqual(legacy);
  const named = { ...legacy, v: 2, clientChannel: 'library' };
  expect(semaphoreRequestSchema.parse(named)).toEqual(named);
  expect(() => semaphoreRequestSchema.parse({ ...legacy, v: 2 })).toThrow(
    /protocol version/
  );
  expect(() =>
    semaphoreRequestSchema.parse({ ...legacy, clientChannel: 'library' })
  ).toThrow(/protocol version/);
});

it('keeps legacy lifecycle event values assignable without client-channel metadata', () => {
  const legacy: DurabilitySemaphoreEvent = {
    entityKind: 'semaphore',
    type: 'grant_reclaimed',
    timestamp: 0,
    grantId: 'g',
    clientId: 'client',
    group: '',
    permits: 1,
  };
  expect(legacy.clientChannel).toBeUndefined();
});
