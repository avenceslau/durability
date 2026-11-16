import { env, waitUntil } from 'cloudflare:workers';
import {
  DurabilityTopology,
  TopologyUnavailableError,
} from 'durability/experimental';
import { DurabilityRouting } from 'durability/routing';
import { coalescer } from './coalesce';
import { partitionFor, partitionName, topologyKey } from './layout';
import type { Layout, Message, PartitionIdentity } from './model';
import { Partition, type AppendCall, type AppendInput } from './partition';

export type PartitionMeta = { epoch: number; index: number };

export type SendOutcome =
  | { accepted: true; ids: string[] }
  | { accepted: false; error: { name: string; message: string } };

export class UnknownQueueError extends Error {
  constructor(queue: string) {
    super(`Queue "${queue}" does not exist`);
    this.name = 'UnknownQueueError';
  }
}

/** A send follows at most this many resizes before it gives up. */
const maxRedirects = 3;

const topology = DurabilityTopology.client<PartitionMeta>({
  read: (queue) => env.TOPOLOGY.get(topologyKey(queue)),
  staleIfErrorMs: 5 * 60_000,
});

/**
 * Partitions that told this isolate they were replaced, and by what layout,
 * per queue. KV is eventually consistent, so a redirect is usually ahead of
 * the published list.
 *
 * A redirect moves only the keys of the partition that gave it. A resize
 * stops the old partitions one after another, and until a key's own
 * partition has stopped, another isolate can still store that key there. A
 * message already in the next epoch would then be delivered after it.
 */
const redirects = new Map<
  string,
  { publishedEpoch: number; byPartition: Map<string, Layout> }
>();

const layoutOf = async (queue: string): Promise<Layout> => {
  let members;
  try {
    ({ members } = await topology.get(queue));
  } catch (error) {
    if (
      error instanceof TopologyUnavailableError &&
      error.reason === 'missing'
    ) {
      throw new UnknownQueueError(queue);
    }
    throw error;
  }

  const active = members.filter((member) => member.state === 'active');
  const published = {
    epoch: active[0]?.meta.epoch ?? 0,
    count: active.length,
  };
  // The list has moved on. What is still ahead of it is learned again.
  if (redirects.get(queue)?.publishedEpoch !== published.epoch) {
    redirects.delete(queue);
  }
  return published;
};

/** Where a key goes, following the redirects this isolate was given. */
const partitionOf = (
  queue: string,
  layout: Layout,
  key: string
): PartitionIdentity => {
  const identity = partitionFor(queue, layout, key);
  const next = redirects.get(queue)?.byPartition.get(partitionName(identity));
  return next ? partitionOf(queue, next, key) : identity;
};

type Share =
  | { success: true }
  | { success: false; error: { name: string; message: string; next?: Layout } };

/** As many messages as a partition stores in one transaction. */
const maxMessagesPerAppend = 1_000;
/**
 * How many messages may wait in this isolate for one partition, and be on
 * their way or waiting for all of them. Past either, a send's share is
 * rejected at once: an isolate that kept everything a slow partition could
 * not take would run out of memory and fail the sends that had been stored.
 */
const maxMessagesWaitingPerPartition = 5 * maxMessagesPerAppend;
const maxMessagesHeld = 100_000;

/**
 * How long this isolate leaves a partition alone once it said it was behind,
 * or failed to answer. Without it every refusal would be followed at once by
 * the next call, and the partition would spend its time refusing.
 */
const partitionBackoffMs = 250;

const createAppend = () => {
  const router = DurabilityRouting.client({
    target: Partition,
    exportName: 'Partition',
    invoke: (stub, call: AppendCall) => stub.append(call),
    sharding: (call) => partitionName(call.inputs[0]!.identity),
  });
  /**
   * Messages refused here for a partition since the last call to it. The
   * next call tells the partition, which is how the autoscaler hears of
   * demand the queue could not take.
   */
  const refused = new Map<string, number>();
  const behindUntil = new Map<string, number>();
  const refuse = (partition: string, input: AppendInput): Share => {
    refused.set(
      partition,
      (refused.get(partition) ?? 0) + input.messages.length
    );
    return {
      success: false,
      error: {
        name: 'Backpressure',
        message: 'The partition is not keeping up; retry later',
      },
    };
  };

  /**
   * A busy partition would be called once per send. Sends that wait for the
   * same partition go to it in one call, which it stores in one transaction:
   * all of them or none.
   */
  const merged = coalescer<AppendInput, Share>({
    invoke: async (partition, inputs) => {
      const reported = refused.get(partition) ?? 0;
      refused.delete(partition);
      const result = await router
        .push({ inputs, issuedAt: Date.now(), refused: reported })
        .catch((error: unknown) => {
          refused.set(partition, (refused.get(partition) ?? 0) + reported);
          behindUntil.set(partition, Date.now() + partitionBackoffMs);
          throw error;
        });
      if (result.success) {
        return inputs.map(() => ({ success: true }));
      }
      if (result.error.name === 'Backpressure') {
        behindUntil.set(partition, Date.now() + partitionBackoffMs);
      }
      const share: Share = { success: false, error: result.error };
      return inputs.map(() => share);
    },
    weigh: (input) => input.messages.length,
    maxWeight: maxMessagesPerAppend,
    maxWaitingWeight: maxMessagesWaitingPerPartition,
    maxHeldWeight: maxMessagesHeld,
    refuse,
    keepAlive: waitUntil,
  });

  return (partition: string, input: AppendInput): Promise<Share> => {
    const until = behindUntil.get(partition);
    if (until !== undefined && Date.now() < until) {
      return Promise.resolve(refuse(partition, input));
    }
    behindUntil.delete(partition);
    return merged(partition, input);
  };
};

// Created on first use: this module and `partition.ts` import each other.
let append: ReturnType<typeof createAppend> | undefined;

/**
 * Accepts one key's messages into a queue. They go to one partition, which
 * stores all of them or none, and a rejection is definite. A thrown error is
 * not: the messages may have been accepted, so retry with the same ids.
 */
export const send = async (
  queue: string,
  input: {
    key: string;
    messages: readonly {
      body: unknown;
      id?: string | undefined;
      dedupeId?: string | undefined;
    }[];
  },
  only?: string[]
): Promise<SendOutcome> => {
  const sentAt = Date.now();
  // One random id for the send, numbered per message: as unique as one each,
  // and a send of hundreds of messages need not draw hundreds.
  const sendId = crypto.randomUUID();
  const messages: Message[] = input.messages.map((message, index) => ({
    id: message.id ?? `${sendId}/${index}`,
    key: input.key,
    body: message.body,
    sentAt,
    ...(only === undefined ? {} : { only }),
    ...(message.dedupeId === undefined ? {} : { dedupeId: message.dedupeId }),
  }));
  const published = await layoutOf(queue);
  append ??= createAppend();

  let identity = partitionOf(queue, published, input.key);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await append(partitionName(identity), {
      identity,
      messages,
    });
    if (result.success) {
      return { accepted: true, ids: messages.map((message) => message.id) };
    }
    const { name, message, next } = result.error;
    if (!next) {
      return { accepted: false, error: { name, message } };
    }
    const known = redirects.get(queue) ?? {
      publishedEpoch: published.epoch,
      byPartition: new Map<string, Layout>(),
    };
    known.byPartition.set(partitionName(identity), next);
    redirects.set(queue, known);
    identity = partitionOf(queue, next, input.key);
  }

  return {
    accepted: false,
    error: {
      name: 'PartitionReplaced',
      message: 'The queue is still resizing; retry shortly',
    },
  };
};

/**
 * For the queue's own senders, whose batches hold many keys: one send per
 * key. Resolves to the ids that were accepted.
 */
export const sendEachKey = async (
  queue: string,
  messages: readonly Pick<Message, 'id' | 'key' | 'body' | 'dedupeId'>[],
  only?: string[]
): Promise<Set<string>> => {
  const byKey = new Map<string, (typeof messages)[number][]>();
  for (const message of messages) {
    const group = byKey.get(message.key);
    if (group) {
      group.push(message);
    } else {
      byKey.set(message.key, [message]);
    }
  }
  const outcomes = await Promise.all(
    [...byKey].map(([key, group]) =>
      send(queue, { key, messages: group }, only)
    )
  );
  return new Set(
    outcomes.flatMap((outcome) => (outcome.accepted ? outcome.ids : []))
  );
};
