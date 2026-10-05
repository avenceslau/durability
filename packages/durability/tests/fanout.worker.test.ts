import { env, exports as workerExports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import {
  defineTransform,
  errorBoundary,
  timeout,
} from '@durability/transforms';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { StoredMessage } from '../src';
import type { RoutingSession } from '../src/routing';
import {
  archivePrefix,
  deadLetterPrefix,
  routing,
  type BatchRequest,
  type DeliveryObject,
  type RouteContext,
  type TestMessage,
} from './fanout-worker';

declare global {
  namespace Cloudflare {
    interface Env {
      DEAD_LETTERS: R2Bucket;
    }
  }
}

const namespace = (workerExports as Record<string, unknown>)[
  'DeliveryObject'
] as DurableObjectNamespace<DeliveryObject>;
const waitFor = async (
  assertion: () => Promise<void>,
  remaining = 80
): Promise<void> => {
  try {
    await assertion();
  } catch (error) {
    if (remaining === 0) {
      throw error;
    }
    await scheduler.wait(10);
    await waitFor(assertion, remaining - 1);
  }
};

describe('composed routing and fanout in workerd', () => {
  it('accepts durably with load then independently delivers consumer and storage targets', async () => {
    const id = crypto.randomUUID();
    const result = await routing.push({
      messages: [{ id, body: { action: 'retry', shard: id } }],
    });
    expect(result).toMatchObject({
      success: true,
      load: { inbound: { completed: 1 }, outbound: { pendingDeliveries: 2 } },
    });
    await waitFor(async () => {
      const load = await namespace.getByName(id).load();
      expect(load.outbound.pendingDeliveries).toBe(0);
      expect(load.outbound.completed).toBe(3);
    });
    const archive = await env.DEAD_LETTERS.list({ prefix: archivePrefix });
    const entries = await Promise.all(
      archive.objects.map(async ({ key }) =>
        (await env.DEAD_LETTERS.get(key))!.json<{ messageId: string }>()
      )
    );
    expect(entries.filter((entry) => entry.messageId === id)).toHaveLength(1);
    expect(await env.DEAD_LETTERS.head(`received/${id}/2`)).not.toBeNull();
  });

  it('uses the actual transforms API and proves routing context selected a different DO', async () => {
    type Value = { ids: string[]; shardId: string };
    const route = defineTransform<
      RoutingSession<BatchRequest, Value, RouteContext>,
      RouteContext
    >().caller(
      (shard: string) =>
        async ({ next }) =>
          next({ context: { shard } })
    );
    const name = crypto.randomUUID();
    const result = await routing
      .with(timeout, 5_000)
      .with(route, name)
      .push({
        messages: [
          { id: name, body: { action: 'ack', shard: 'not-selected' } },
        ],
      });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(result.error.message);
    }
    expectTypeOf(result.value.ids).toEqualTypeOf<string[]>();
    expect(result.value.shardId).toBe(namespace.idFromName(name).toString());
    const safe = routing.with(errorBoundary);
    expectTypeOf(safe.push).returns.toMatchTypeOf<Promise<unknown>>();
    await waitFor(async () =>
      expect(
        (await namespace.getByName(name).load()).outbound.pendingDeliveries
      ).toBe(0)
    );
  });

  it('redrives only the failed target through routing after reading storage', async () => {
    const name = crypto.randomUUID();
    await routing.push({
      messages: [{ id: name, body: { action: 'deadLetter', shard: name } }],
    });
    // Applications read their own storage; nothing in the library does it.
    const deadLetters = async (): Promise<
      Array<{ key: string; entry: StoredMessage<TestMessage> }>
    > => {
      const page = await env.DEAD_LETTERS.list({ prefix: deadLetterPrefix });
      const stored = await Promise.all(
        page.objects.map(async ({ key }) => ({
          key,
          entry: await (await env.DEAD_LETTERS.get(key))!.json<
            StoredMessage<TestMessage>
          >(),
        }))
      );
      return stored.filter(({ entry }) => entry.messageId === name);
    };
    await waitFor(async () => expect(await deadLetters()).toHaveLength(1));
    const [found] = await deadLetters();
    const { key: entryKey, entry } = found!;
    const result = await routing.push(
      {
        messages: [
          {
            id: entry.messageId,
            deduplicationKey: entry.id,
            body: { ...entry.body, action: 'ack' },
          },
        ],
        options: { targets: [entry.target] },
      },
      { shard: `${name}-redrive` }
    );
    expect(result).toMatchObject({
      success: true,
      load: { outbound: { pendingDeliveries: 1 } },
    });
    expect(entry.failure).toEqual({ reason: 'explicit', error: null });
    if (result.success) {
      await env.DEAD_LETTERS.delete(entryKey);
    }
    await waitFor(async () =>
      expect(
        (await namespace.getByName(`${name}-redrive`).load()).outbound
          .pendingDeliveries
      ).toBe(0)
    );
    const archived = await env.DEAD_LETTERS.list({ prefix: archivePrefix });
    const entries = await Promise.all(
      archived.objects.map(async ({ key }) =>
        (await env.DEAD_LETTERS.get(key))!.json<{ messageId: string }>()
      )
    );
    expect(
      entries.filter((message) => message.messageId === name)
    ).toHaveLength(1);
  });

  it('rejects an atomic batch without leaving earlier messages after a conflict', async () => {
    const name = crypto.randomUUID();
    const stub = namespace.getByName(name);
    const message = {
      id: name,
      body: { action: 'ignore' as const, shard: name },
    };
    await stub.enqueue({ messages: [message] });
    const result = await stub.enqueue({
      messages: [
        { id: `${name}-new`, body: { action: 'ack', shard: name } },
        { ...message, body: { action: 'ack', shard: name } },
      ],
    });
    expect(result).toMatchObject({
      success: false,
      error: { name: 'FanoutEnqueueError' },
    });
    await waitFor(async () =>
      expect((await stub.load()).outbound.pendingDeliveries).toBe(0)
    );
    expect(await env.DEAD_LETTERS.head(`received/${name}-new/1`)).toBeNull();
  });

  it('composes named alarms and fanout in an application DO across eviction', async () => {
    const name = crypto.randomUUID();
    const stub = namespace.getByName(name);
    await stub.scheduleCleanup(Date.now() + 60);
    await stub.enqueue({
      messages: [{ body: { action: 'ack', shard: name } }],
    });
    await waitFor(async () =>
      expect((await stub.load()).outbound.pendingDeliveries).toBe(0)
    );
    await evictDurableObject(stub);
    await scheduler.wait(70);
    const recovered = namespace.getByName(name);
    await runDurableObjectAlarm(recovered);
    expect(await recovered.cleaned()).toBe(true);
    expect((await recovered.load()).inbound.completed).toBe(0);
  });
});
