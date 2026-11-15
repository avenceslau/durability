import { runInDurableObject, SELF } from 'cloudflare:test';
import { env, exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { QueueAdmin, QueueBinding } from '../src/index';
import type {
  Overview,
  PartitionConfig,
  PullBatch,
  RedriveStatus,
} from '../src/model';
import type { Partition } from '../src/partition';
import type {
  Behaviour,
  Received,
  ScriptedConsumer,
  SinkStore,
} from './worker';

const stores = (workerExports as Record<string, unknown>)[
  'SinkStore'
] as DurableObjectNamespace<SinkStore>;
const partitions = (workerExports as Record<string, unknown>)[
  'Partition'
] as DurableObjectNamespace<Partition>;
/** The service bindings other Workers would declare; see `wrangler.test.jsonc`. */
const {
  QUEUE: queueBinding,
  ADMIN: queueAdmin,
  SCRIPTED: scripted,
} = env as unknown as {
  QUEUE: Service<QueueBinding>;
  ADMIN: Service<QueueAdmin>;
  SCRIPTED: Service<ScriptedConsumer>;
};

const admin = (path: string, method = 'GET', body?: unknown) =>
  SELF.fetch(`https://queue.test/api${path}`, {
    method,
    headers: {
      Authorization: 'Bearer admin',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const expectOk = async (response: Response): Promise<Response> => {
  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }
  return response;
};

const createQueue = async (settings: object = {}): Promise<string> => {
  const name = `q-${crypto.randomUUID()}`;
  await expectOk(await admin('/queues', 'POST', { name, settings }));
  return name;
};

const addTarget = async (
  queue: string,
  target: string,
  settings: object = {},
  behaviour: Behaviour = {}
) => {
  await stores.getByName(queue).behave(target, behaviour);
  await expectOk(
    await admin(`/queues/${queue}/targets/${target}`, 'PUT', {
      destination: { type: 'service', binding: 'SINK' },
      ...settings,
    })
  );
};

const produce = async (
  queue: string,
  messages: { key: string; body: number; id?: string }[]
) =>
  SELF.fetch(`https://queue.test/queues/${queue}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer producer' },
    body: JSON.stringify(messages),
  });

const overview = async (queue: string): Promise<Overview> =>
  (await expectOk(await admin(`/queues/${queue}`))).json();

const waitFor = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  remaining = 400
): Promise<T> => {
  const value = await read();
  if (done(value)) {
    return value;
  }
  if (remaining === 0) {
    throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
  }
  await scheduler.wait(50);
  return waitFor(read, done, remaining - 1);
};

/** Pulls and acknowledges until the consumer has received `count` messages. */
const pullAll = async (
  queue: string,
  consumer: string,
  count: number,
  remaining = 300
): Promise<Record<string, number[]>> => {
  const byKey: Record<string, number[]> = {};
  let received = 0;
  for (let attempt = 0; received < count; attempt += 1) {
    if (attempt === remaining) {
      throw new Error(`Pulled only ${received} of ${count} messages`);
    }
    // eslint-disable-next-line no-await-in-loop
    const batch = await queueBinding.pull(queue, consumer);
    if (!batch) {
      // eslint-disable-next-line no-await-in-loop
      await scheduler.wait(100);
      continue;
    }
    for (const message of batch.messages) {
      (byKey[message.key] ??= []).push(message.body as number);
    }
    received += batch.messages.length;
    // eslint-disable-next-line no-await-in-loop
    expect(await queueBinding.ack(queue, consumer, batch.lease)).toBe(true);
  }
  return byKey;
};

const bodiesByKey = (deliveries: Received[]): Record<string, number[]> => {
  const byKey: Record<string, number[]> = {};
  for (const delivery of deliveries) {
    for (const [index, key] of delivery.keys.entries()) {
      (byKey[key] ??= []).push(delivery.bodies[index]!);
    }
  }
  return byKey;
};

const received = (queue: string, target: string, count: number) =>
  waitFor(
    () => stores.getByName(queue).deliveries(target),
    (deliveries) =>
      deliveries.reduce((all, entry) => all + entry.keys.length, 0) >= count
  );

describe('fifo queue', () => {
  it('delivers each key in order to every target', async () => {
    const queue = await createQueue({ partitions: { min: 4, max: 4 } });
    await addTarget(queue, 'first');
    await addTarget(queue, 'second', { maxBatchSize: 3 });

    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (let round = 0; round < 5; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await produce(
        queue,
        keys.map((key) => ({ key, body: round }))
      );
      expect(response.status).toBe(202);
    }

    for (const target of ['first', 'second']) {
      // eslint-disable-next-line no-await-in-loop
      const byKey = bodiesByKey(await received(queue, target, 30));
      for (const key of keys) {
        expect(byKey[key]).toEqual([0, 1, 2, 3, 4]);
      }
    }
  });

  it('retries a message before the next of its key, then dead-letters it', async () => {
    const queue = await createQueue();
    // Both deliveries of the first message fail and it is dead-lettered; the
    // third failure is the second message's first delivery.
    await addTarget(
      queue,
      'flaky',
      { maxBatchSize: 1, maxRetries: 1 },
      { failures: 3 }
    );

    await produce(queue, [
      { key: 'k', body: 1 },
      { key: 'k', body: 2 },
      { key: 'k', body: 3 },
    ]);

    const deliveries = await received(queue, 'flaky', 2);
    expect(deliveries.map((entry) => [entry.bodies, entry.attempts])).toEqual([
      [[2], [2]],
      [[3], [1]],
    ]);

    const deadLetters = await env.STORAGE.list({
      prefix: `dead-letters/${queue}/flaky/`,
    });
    expect(deadLetters.objects).toHaveLength(1);
    const state = await waitFor(
      () => overview(queue),
      (current) => current.partitions[0]?.targets['flaky']?.deadLettered === 1
    );
    expect(state.partitions[0]?.targets['flaky']?.retries).toBe(3);

    const started = await admin(
      `/queues/${queue}/targets/flaky/redrive`,
      'POST'
    );
    expect(started.status).toBe(202);
    const finished = await waitFor(
      async () =>
        (await admin(`/queues/${queue}/redrive`)).json<RedriveStatus>(),
      (status) => !status.running
    );
    expect(finished).toMatchObject({ target: 'flaky', redriven: 1, left: 0 });
    const afterRedrive = await received(queue, 'flaky', 3);
    expect(afterRedrive[2]?.bodies).toEqual([1]);
  });

  it('replays every dead letter of every target through the binding', async () => {
    const queue = await createQueue({ partitions: { min: 2, max: 2 } });
    // More dead letters than one listing page holds, across two targets.
    const count = 120;
    const failing = { maxBatchSize: 1, maxRetries: 0 };
    await addTarget(queue, 'first', failing, { failures: count });
    await addTarget(queue, 'second', failing, { failures: count });
    await addTarget(queue, 'healthy');

    await produce(
      queue,
      Array.from({ length: count }, (_, body) => ({ key: `key-${body}`, body }))
    );
    await received(queue, 'healthy', count);
    const deadLetters = (target: string) =>
      env.STORAGE.list({
        prefix: `dead-letters/${queue}/${target}/`,
        limit: 1000,
      });
    await waitFor(
      async () => [
        (await deadLetters('first')).objects.length,
        (await deadLetters('second')).objects.length,
      ],
      (counts) => counts.every((entries) => entries === count)
    );

    // The call starts a job on the Redriver object and returns at once.
    expect(await queueBinding.redrive(queue)).toMatchObject({ running: true });
    const finished = await waitFor(
      () => queueBinding.redriveStatus(queue),
      (status) => status?.running === false
    );
    expect(finished).toMatchObject({ redriven: 2 * count, left: 0 });
    expect(finished?.target).toBeUndefined();
    expect((await deadLetters('first')).objects).toEqual([]);
    expect((await deadLetters('second')).objects).toEqual([]);

    for (const target of ['first', 'second']) {
      // eslint-disable-next-line no-await-in-loop
      const byKey = bodiesByKey(await received(queue, target, count));
      expect(Object.keys(byKey)).toHaveLength(count);
    }
    // Redriven messages are marked for the target that failed them.
    expect(
      (await stores.getByName(queue).deliveries('healthy')).reduce(
        (all, entry) => all + entry.keys.length,
        0
      )
    ).toBe(count);
  });

  it('lets several pull consumers read every key in order', async () => {
    const queue = await createQueue({
      partitions: { min: 3, max: 3 },
      pullConsumers: true,
    });
    expect((await overview(queue)).targets['pull']?.destination).toEqual({
      type: 'pull',
    });
    const reserved = await admin(`/queues/${queue}/targets/pull`, 'PUT', {
      destination: { type: 'archive' },
    });
    expect(reserved.status).toBe(409);

    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (let round = 0; round < 5; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      await produce(
        queue,
        keys.map((key) => ({ key, body: round }))
      );
    }

    for (const consumer of ['billing', 'search']) {
      // eslint-disable-next-line no-await-in-loop
      const byKey = await pullAll(queue, consumer, 30);
      for (const key of keys) {
        expect(byKey[key]).toEqual([0, 1, 2, 3, 4]);
      }
      // eslint-disable-next-line no-await-in-loop
      expect(await queueBinding.pull(queue, consumer)).toBeUndefined();
    }
  });

  it('hands unacknowledged messages out again, over HTTP too', async () => {
    const queue = await createQueue({ pullConsumers: true });
    await produce(queue, [
      { key: 'k', body: 1 },
      { key: 'k', body: 2 },
    ]);

    const first = await waitFor(
      () => queueBinding.pull(queue, 'slow', { visibilityMs: 300 }),
      (batch) => batch !== undefined
    );
    expect(first?.attempt).toBe(1);
    // The lease is still running, and one partition hands out one range at a time.
    expect(await queueBinding.pull(queue, 'slow')).toBeUndefined();

    const request = (action: string, body: object, token = 'consumer') =>
      SELF.fetch(
        `https://queue.test/queues/${queue}/consumers/slow/${action}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }
      );
    expect((await request('pull', {}, 'producer')).status).toBe(401);
    const second = await waitFor(
      async () => (await request('pull', {})).json<PullBatch | null>(),
      (batch) => batch !== null
    );
    expect(second?.attempt).toBe(2);
    expect(second?.messages.map((message) => message.body)).toEqual(
      first?.messages.map((message) => message.body)
    );

    const stale = await request('ack', { lease: first!.lease });
    expect(stale.status).toBe(409);
    const current = await request('ack', { lease: second!.lease });
    expect(await current.json()).toEqual({ settled: true });
  });

  it('removes batches from the pull bucket when their retention ends', async () => {
    const queue = await createQueue({ pullConsumers: true });
    await produce(queue, [
      { key: 'a', body: 1 },
      { key: 'b', body: 2 },
    ]);
    const stored = () => env.PULL.list({ prefix: `${queue}/` });
    await waitFor(stored, (page) => page.objects.length > 0);

    // Retention is counted in days, so the test shortens it to a millisecond
    // in the partition's stored config and runs the sweep itself.
    const { epochs } = await overview(queue);
    const partition = partitions.getByName(`${queue}/${epochs[0]!.epoch}/0`);
    await runInDurableObject(partition, async (instance, state) => {
      const config = state.storage.kv.get<PartitionConfig>('config')!;
      state.storage.kv.put('config', { ...config, pullRetentionMs: 1 });
      await scheduler.wait(5);
      await (
        instance as unknown as { enforceRetention(): Promise<void> }
      ).enforceRetention();
      expect(
        state.storage.sql.exec('SELECT object_key FROM pull_batches').toArray()
      ).toEqual([]);
    });
    expect((await stored()).objects).toEqual([]);
  });

  it('keeps pulled keys in order across a resize', async () => {
    const queue = await createQueue({
      partitions: { min: 2, max: 8 },
      pullConsumers: true,
    });
    const keys = Array.from({ length: 8 }, (_, index) => `key-${index}`);
    const sendRound = (body: number) =>
      produce(
        queue,
        keys.map((key) => ({ key, body }))
      );

    for (let body = 0; body < 5; body += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sendRound(body);
    }
    await expectOk(
      await admin(`/queues/${queue}/resize`, 'POST', { partitions: 5 })
    );
    for (let body = 5; body < 10; body += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sendRound(body);
    }

    const byKey = await pullAll(queue, 'reader', keys.length * 10);
    for (const key of keys) {
      expect(byKey[key]).toEqual(Array.from({ length: 10 }, (_, n) => n));
    }
  });

  it('dead-letters what a queue without targets accepts, for a later redrive', async () => {
    const queue = await createQueue();
    await produce(queue, [
      { key: 'a', body: 1 },
      { key: 'a', body: 2 },
      { key: 'b', body: 3 },
    ]);

    const point = await waitFor(
      async () => {
        const { points } = await overview(queue);
        return points[points.length - 1];
      },
      (latest) => latest?.withoutTarget === 3
    );
    expect(point?.accepted).toBe(3);
    const stored = await env.STORAGE.list({
      prefix: `dead-letters/${queue}/_no-target/`,
    });
    expect(stored.objects.length).toBeGreaterThan(0);

    // A target added later was not there for those messages; a redrive
    // delivers them to it.
    await addTarget(queue, 'late');
    await queueBinding.redrive(queue);
    const byKey = bodiesByKey(await received(queue, 'late', 3));
    expect(byKey).toEqual({ a: [1, 2], b: [3] });
    await produce(queue, [{ key: 'a', body: 4 }]);
    expect(bodiesByKey(await received(queue, 'late', 4))['a']).toEqual([
      1, 2, 4,
    ]);
  });

  it('holds back only the key of a retried message', async () => {
    const queue = await createQueue();
    await stores.getByName(queue).behave('orders', { retryOnce: [1] });
    await expectOk(
      await admin(`/queues/${queue}/targets/orders`, 'PUT', {
        destination: { type: 'rpc', binding: 'RPC_SINK' },
        retryDelaySeconds: 1,
      })
    );

    // `a` and `b` share the batch. The consumer retries a:1, so a:2 waits
    // behind it while both of b's messages are done at once.
    await produce(queue, [
      { key: 'a', body: 1 },
      { key: 'a', body: 2 },
      { key: 'b', body: 3 },
      { key: 'b', body: 4 },
    ]);
    const deliveries = await received(queue, 'orders', 4);
    expect(
      deliveries.map((entry) => [entry.keys, entry.bodies, entry.attempts])
    ).toEqual([
      [
        ['b', 'b'],
        [3, 4],
        [1, 1],
      ],
      // The first delivery of a:2 did not count against it.
      [
        ['a', 'a'],
        [1, 2],
        [2, 1],
      ],
    ]);
    expect(
      (await overview(queue)).partitions[0]?.targets['orders']
    ).toMatchObject({ retries: 1, deadLettered: 0 });
  });

  it('lets a POSTed target retry single messages in its answer', async () => {
    const queue = await createQueue();
    await addTarget(queue, 'hook', {}, { retryOnce: [2] });

    await produce(queue, [
      { key: 'a', body: 1 },
      { key: 'b', body: 2 },
      { key: 'c', body: 3 },
    ]);
    const deliveries = await received(queue, 'hook', 3);
    expect(deliveries.map((entry) => [entry.bodies, entry.attempts])).toEqual([
      [
        [1, 3],
        [1, 1],
      ],
      [[2], [2]],
    ]);
  });

  it('settles a batch the way Cloudflare Queues does', async () => {
    const delivery = (bodies: string[]) => ({
      queue: 'q',
      target: 't',
      partition: 'q/1/0',
      messages: bodies.map((body, index) => ({
        id: `m${index}`,
        key: 'k',
        offset: index,
        body,
        sentAt: 0,
        attempts: 1,
      })),
    });
    const settle = (bodies: string[]) =>
      scripted.deliverQueueBatch(delivery(bodies));

    // The first call on a message wins; returning acknowledges the rest.
    expect(
      await settle(['ack then retry', 'retry then ack', 'left alone'])
    ).toEqual({
      acked: ['m0', 'm2'],
      retried: [{ id: 'm1', delaySeconds: 5 }],
    });
    // A call on a message beats a call on the batch, and the first call on the batch wins.
    expect(await settle(['ack then retry', 'retry all', 'left alone'])).toEqual(
      {
        acked: ['m0'],
        retried: [
          { id: 'm1', delaySeconds: 9 },
          { id: 'm2', delaySeconds: 9 },
        ],
      }
    );
    // Throwing retries what was not acknowledged.
    expect(await settle(['ack then retry', 'throw'])).toEqual({
      acked: ['m0'],
      retried: [{ id: 'm1' }],
    });
    expect(await settle(['ack all', 'throw'])).toEqual({
      acked: ['m0', 'm1'],
      retried: [],
    });
  });

  it('configures queues over the admin binding', async () => {
    const queue = `q-${crypto.randomUUID()}`;
    await queueAdmin.create(queue, { partitions: { min: 2 } });
    await queueAdmin.putTarget(queue, 'orders', {
      destination: { type: 'rpc', binding: 'RPC_SINK' },
    });
    await queueAdmin.updateSettings(queue, { maxBacklog: 7 });

    const state = await queueAdmin.overview(queue);
    expect(state.settings).toMatchObject({
      partitions: { min: 2, max: 16 },
      maxBacklog: 7,
    });
    expect(state.targets['orders']).toMatchObject({
      maxBatchSize: 10,
      maxRetries: 3,
    });
    expect((await queueAdmin.list()).map((entry) => entry.name)).toContain(
      queue
    );

    await queueBinding.send(queue, [{ key: 'k', body: 1 }]);
    expect(bodiesByKey(await received(queue, 'orders', 1))).toEqual({ k: [1] });

    await queueAdmin.delete(queue);
    expect((await queueAdmin.list()).map((entry) => entry.name)).not.toContain(
      queue
    );
  });

  it('keeps every key in order across a resize', async () => {
    const queue = await createQueue({ partitions: { min: 2, max: 8 } });
    await addTarget(queue, 'slow', { maxBatchSize: 2 }, { delayMs: 20 });
    const keys = Array.from({ length: 12 }, (_, index) => `key-${index}`);
    const send = (from: number, to: number) =>
      Promise.all(
        keys.map(async (key) => {
          for (let body = from; body < to; body += 1) {
            // eslint-disable-next-line no-await-in-loop
            const response = await produce(queue, [{ key, body }]);
            expect(response.status).toBe(202);
          }
        })
      );

    await send(0, 5);
    const resizing = admin(`/queues/${queue}/resize`, 'POST', {
      partitions: 5,
    });
    await send(5, 10);
    await expectOk(await resizing);
    await send(10, 15);

    const byKey = bodiesByKey(await received(queue, 'slow', keys.length * 15));
    for (const key of keys) {
      expect(byKey[key]).toEqual(Array.from({ length: 15 }, (_, n) => n));
    }

    const settled = await waitFor(
      () => overview(queue),
      (current) => current.epochs.length === 1
    );
    expect(settled.epochs[0]?.count).toBe(5);
    expect(settled.targets['slow']?.deliverFromEpoch).toBe(
      settled.epochs[0]?.epoch
    );
  });

  it('never runs more batches at once than the queue limit', async () => {
    const queue = await createQueue({
      partitions: { min: 8, max: 8 },
      maxConcurrency: 2,
    });
    await addTarget(queue, 'limited', { maxBatchSize: 1 }, { delayMs: 30 });

    const keys = Array.from({ length: 24 }, (_, index) => `key-${index}`);
    await produce(
      queue,
      keys.flatMap((key) => [
        { key, body: 0 },
        { key, body: 1 },
      ])
    );

    const byKey = bodiesByKey(await received(queue, 'limited', 48));
    for (const key of keys) {
      expect(byKey[key]).toEqual([0, 1]);
    }
    expect(
      await stores.getByName(queue).mostRunningAtOnce()
    ).toBeLessThanOrEqual(2);
  });

  it('rejects sends once a target is too far behind', async () => {
    const queue = await createQueue({ maxBacklog: 3 });
    // The first failure parks the message for a minute, and its key with it.
    await addTarget(
      queue,
      'stuck',
      { retryDelaySeconds: 60 },
      { failures: 1_000 }
    );

    const first = await produce(queue, [
      { key: 'k', body: 1 },
      { key: 'k', body: 2 },
      { key: 'k', body: 3 },
    ]);
    expect(first.status).toBe(202);
    const second = await produce(queue, [{ key: 'k', body: 4 }]);
    expect(second.status).toBe(429);
  });

  it('forwards to another queue as a target', async () => {
    const downstream = await createQueue();
    await addTarget(downstream, 'end');
    const upstream = await createQueue();
    await expectOk(
      await admin(`/queues/${upstream}/targets/forward`, 'PUT', {
        destination: { type: 'queue', queue: downstream },
      })
    );

    await produce(upstream, [
      { key: 'k', body: 1 },
      { key: 'k', body: 2 },
    ]);
    const byKey = bodiesByKey(await received(downstream, 'end', 2));
    expect(byKey['k']).toEqual([1, 2]);
  });

  it('holds a paused target and resumes it in order', async () => {
    const queue = await createQueue();
    await addTarget(queue, 'held', { paused: true });
    await addTarget(queue, 'running');

    await produce(queue, [
      { key: 'k', body: 1 },
      { key: 'k', body: 2 },
    ]);
    await received(queue, 'running', 2);
    expect(await stores.getByName(queue).deliveries('held')).toEqual([]);

    await expectOk(
      await admin(`/queues/${queue}/targets/held/pause`, 'POST', {
        paused: false,
      })
    );
    const byKey = bodiesByKey(await received(queue, 'held', 2));
    expect(byKey['k']).toEqual([1, 2]);
  });

  it('reports cumulative counters the dashboard turns into rates', async () => {
    const queue = await createQueue({ partitions: { min: 3, max: 3 } });
    await addTarget(queue, 'counted');
    await produce(
      queue,
      Array.from({ length: 30 }, (_, body) => ({ key: `key-${body}`, body }))
    );

    const state = await waitFor(
      () => overview(queue),
      (current) => {
        const point = current.points[current.points.length - 1];
        return point?.targets['counted']?.settled === 30;
      }
    );
    const point = state.points[state.points.length - 1]!;
    expect(point.accepted).toBe(30);
    expect(point.partitions).toBe(3);
    expect(point.targets['counted']).toMatchObject({
      pending: 0,
      deadLettered: 0,
    });
  });

  it('removes a concurrency limit and a target, then deletes the queue', async () => {
    const queue = await createQueue({ maxConcurrency: 1 });
    await addTarget(queue, 'kept');
    await addTarget(queue, 'dropped');
    expect((await overview(queue)).limiters.active).toHaveLength(1);

    await expectOk(
      await admin(`/queues/${queue}`, 'PATCH', { maxConcurrency: null })
    );
    await expectOk(await admin(`/queues/${queue}/targets/dropped`, 'DELETE'));
    const state = await overview(queue);
    expect(state.limiters.active).toEqual([]);
    expect(Object.keys(state.targets)).toEqual(['kept']);

    await produce(queue, [{ key: 'k', body: 1 }]);
    await received(queue, 'kept', 1);
    expect(await stores.getByName(queue).deliveries('dropped')).toEqual([]);

    await expectOk(await admin(`/queues/${queue}`, 'DELETE'));
    expect((await admin(`/queues/${queue}`)).status).toBe(409);
    const names = await (await admin('/queues')).json<{ name: string }[]>();
    expect(names.map((entry) => entry.name)).not.toContain(queue);
  });

  it('requires the right token for each API', async () => {
    const queue = await createQueue();
    const withoutToken = await SELF.fetch(`https://queue.test/api/queues`);
    expect(withoutToken.status).toBe(401);
    const producerOnAdmin = await SELF.fetch(`https://queue.test/api/queues`, {
      headers: { Authorization: 'Bearer producer' },
    });
    expect(producerOnAdmin.status).toBe(401);
    const adminOnProduce = await SELF.fetch(
      `https://queue.test/queues/${queue}/messages`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin' },
        body: JSON.stringify([{ key: 'k', body: 1 }]),
      }
    );
    expect(adminOnProduce.status).toBe(401);

    const fractional = await admin(`/queues/${queue}/resize`, 'POST', {
      partitions: 1.5,
    });
    expect(fractional.status).toBe(400);
    const unknownTarget = await admin(
      `/queues/${queue}/targets/missing/redrive`,
      'POST'
    );
    expect(unknownTarget.status).toBe(404);

    const signIn = await SELF.fetch('https://queue.test/api/session', {
      method: 'POST',
      body: JSON.stringify({ token: 'admin' }),
    });
    const session = signIn.headers.get('Set-Cookie')!.split(';')[0]!;
    const resizeWithCookie = (origin?: string) =>
      SELF.fetch(`https://queue.test/api/queues/${queue}/resize`, {
        method: 'POST',
        headers: {
          Cookie: session,
          ...(origin === undefined ? {} : { Origin: origin }),
        },
        body: JSON.stringify({ partitions: 1 }),
      });
    expect((await resizeWithCookie()).status).toBe(401);
    expect((await resizeWithCookie('https://other.test')).status).toBe(401);
    expect((await resizeWithCookie('https://queue.test')).status).toBe(204);
    const read = await SELF.fetch(`https://queue.test/api/queues/${queue}`, {
      headers: { Cookie: session },
    });
    expect(read.status).toBe(200);

    const duplicate = await admin('/queues', 'POST', { name: queue });
    expect(duplicate.status).toBe(409);
    const missing = await produce('no-such-queue', [{ key: 'k', body: 1 }]);
    expect(missing.status).toBe(404);
  });
});
