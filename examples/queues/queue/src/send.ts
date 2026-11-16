import { env, waitUntil } from 'cloudflare:workers';
import {
  DurabilityTopology,
  TopologyUnavailableError,
} from 'durability/experimental';
import { DurabilityRouting } from 'durability/routing';
import { coalescer } from './coalesce';
import { partitionFor, partitionName, topologyKey } from './layout';
import type { Layout, Message, MessageInput } from './model';
import { Partition, type AppendInput } from './partition';

export type PartitionMeta = { epoch: number; index: number };

export type SendOutcome = {
  accepted: string[];
  rejected: {
    ids: string[];
    error: { name: string; message: string };
  }[];
};

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
 * Layouts a replaced partition told this isolate about. KV is eventually
 * consistent, so the redirect is usually ahead of the published snapshot.
 */
const redirected = new Map<string, Layout>();

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
  const learned = redirected.get(queue);
  if (learned && learned.epoch > published.epoch) {
    return learned;
  }
  redirected.delete(queue);
  return published;
};

type Share =
  | { success: true }
  | { success: false; error: { name: string; message: string; next?: Layout } };

/** As many messages as a partition stores in one transaction. */
const maxMessagesPerAppend = 1_000;

const createAppend = () => {
  const router = DurabilityRouting.client({
    target: Partition,
    exportName: 'Partition',
    invoke: (stub, inputs: AppendInput[]) => stub.append(inputs),
    sharding: (inputs) => partitionName(inputs[0]!.identity),
  });
  /**
   * Every send touches most partitions of its queue, so a partition would be
   * called once per send however many partitions there are. Sends that wait
   * for the same partition go to it in one call, which it stores in one
   * transaction: all of them or none.
   */
  return coalescer<AppendInput, Share>({
    invoke: async (_partition, inputs) => {
      const result = await router.push(inputs);
      const share: Share = result.success
        ? { success: true }
        : { success: false, error: result.error };
      return inputs.map(() => share);
    },
    weigh: (input) => input.messages.length,
    maxWeight: maxMessagesPerAppend,
    keepAlive: waitUntil,
  });
};

// Created on first use: this module and `partition.ts` import each other.
let append: ReturnType<typeof createAppend> | undefined;

const groupByPartition = (
  queue: string,
  layout: Layout,
  messages: readonly Message[]
): AppendInput[] => {
  const groups = new Map<number, AppendInput>();
  for (const message of messages) {
    const identity = partitionFor(queue, layout, message.key);
    const group = groups.get(identity.index) ?? { identity, messages: [] };
    group.messages.push(message);
    groups.set(identity.index, group);
  }
  return [...groups.values()];
};

/**
 * Accepts messages into a queue. Each partition's share commits atomically; a
 * rejected share is definite. A thrown error is not: the messages may have been
 * accepted, so retry with the same ids.
 */
export const send = async (
  queue: string,
  inputs: readonly (MessageInput & Pick<Message, 'dedupeId'>)[],
  only?: string[]
): Promise<SendOutcome> => {
  const sentAt = Date.now();
  let remaining: Message[] = inputs.map((input) => ({
    id: input.id ?? crypto.randomUUID(),
    key: input.key,
    body: input.body,
    sentAt,
    ...(only === undefined ? {} : { only }),
    ...(input.dedupeId === undefined ? {} : { dedupeId: input.dedupeId }),
  }));
  const outcome: SendOutcome = { accepted: [], rejected: [] };
  let layout = await layoutOf(queue);
  append ??= createAppend();
  const toPartition = append;

  for (let hop = 0; hop <= maxRedirects && remaining.length > 0; hop += 1) {
    const groups = groupByPartition(queue, layout, remaining);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(
      groups.map((group) => toPartition(partitionName(group.identity), group))
    );

    remaining = [];
    let next: Layout | undefined;
    for (const [index, result] of results.entries()) {
      const { messages } = groups[index]!;
      const ids = messages.map((message) => message.id);
      if (result.success) {
        outcome.accepted.push(...ids);
        continue;
      }

      const redirect =
        'next' in result.error ? (result.error.next as Layout) : undefined;
      if (redirect) {
        next = redirect;
        remaining.push(...messages);
        continue;
      }
      outcome.rejected.push({ ids, error: result.error });
    }

    if (next) {
      redirected.set(queue, next);
      layout = next;
    }
  }

  if (remaining.length > 0) {
    outcome.rejected.push({
      ids: remaining.map((message) => message.id),
      error: {
        name: 'PartitionReplaced',
        message: 'The queue is still resizing; retry shortly',
      },
    });
  }
  return outcome;
};
