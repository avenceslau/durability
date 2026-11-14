import { env } from 'cloudflare:workers';
import { orchestrators } from './namespaces';
import { send } from './send';
import type { Delivery } from './targets';

export type RedriveOutcome = {
  /** Messages accepted back into the queue. */
  redriven: number;
  /** Messages the queue refused; their dead letters stay where they are. */
  left: number;
};

export class UnknownTargetError extends Error {
  constructor(target: string) {
    super(`No target named "${target}"`);
    this.name = 'UnknownTargetError';
  }
}

const pageSize = 100;

/**
 * Sends one dead-lettered batch through the queue again, for its target only.
 * The entry is deleted once its messages were accepted, so a crash in between
 * can deliver a message twice but never loses one.
 */
const redriveEntry = async (
  queue: string,
  target: string,
  key: string
): Promise<RedriveOutcome> => {
  const stored = await env.STORAGE.get(key);
  if (!stored) {
    return { redriven: 0, left: 0 };
  }
  const entry = await stored.json<Delivery>();
  const outcome = await send(
    queue,
    entry.messages.map((message) => ({
      key: message.key,
      body: message.body,
      id: `redrive/${key}/${message.offset}`,
    })),
    [target]
  );
  if (outcome.rejected.length > 0) {
    return { redriven: 0, left: entry.messages.length };
  }

  await env.STORAGE.delete(key);
  return { redriven: entry.messages.length, left: 0 };
};

/**
 * Replays every dead letter of a queue, or of one target, through the queue.
 * Each message goes only to the target that gave up on it. Messages arrive
 * after whatever that target received since, so order does not cover them.
 *
 * Dead letters of a target that no longer exists are left alone: no target
 * would receive them.
 */
export const redrive = async (
  queue: string,
  target?: string
): Promise<RedriveOutcome> => {
  const targets = await orchestrators().getByName(queue).targetNames();
  if (target !== undefined && !targets.includes(target)) {
    throw new UnknownTargetError(target);
  }

  const startedAt = Date.now();
  const total: RedriveOutcome = { redriven: 0, left: 0 };
  for (const name of target === undefined ? targets : [target]) {
    let cursor: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await env.STORAGE.list({
        prefix: `dead-letters/${queue}/${name}/`,
        limit: pageSize,
        ...(cursor === undefined ? {} : { cursor }),
      });
      // A batch that fails again while this runs is a new dead letter;
      // replaying those too could go round forever.
      const entries = page.objects.filter(
        (object) => object.uploaded.getTime() < startedAt
      );
      for (const object of entries) {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await redriveEntry(queue, name, object.key);
        total.redriven += outcome.redriven;
        total.left += outcome.left;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
  }
  return total;
};
