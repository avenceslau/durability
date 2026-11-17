import type { Layout, PartitionIdentity } from './model';

/**
 * FNV-1a with a final mix. It must give the same answer in every isolate and
 * after every deploy, and the mix keeps similar strings from hashing alike.
 */
const hash = (text: string): number => {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;
  return value >>> 0;
};

export const partitionName = (identity: PartitionIdentity): string =>
  `${identity.queue}/${identity.epoch}/${identity.index}`;

const regions: DurableObjectLocationHint[] = [
  'wnam',
  'enam',
  'sam',
  'weur',
  'eeur',
  'apac',
  'oc',
  'afr',
  'me',
];

/**
 * Where a partition is placed. Left alone, every partition of a queue would
 * start next to the orchestrator, which reaches each of them first.
 */
export const partitionRegion = (
  identity: PartitionIdentity
): DurableObjectLocationHint => regions[identity.index % regions.length]!;

export const partitionFor = (
  queue: string,
  layout: Layout,
  key: string
): PartitionIdentity => ({
  queue,
  epoch: layout.epoch,
  index: hash(key) % layout.count,
});

export const partitionsOf = (
  queue: string,
  layout: Layout
): PartitionIdentity[] =>
  Array.from({ length: layout.count }, (_, index) => ({
    queue,
    epoch: layout.epoch,
    index,
  }));

export const limiterName = (queue: string, number: number): string =>
  `${queue}/limiter/${number}`;

/**
 * Rendezvous hashing: every partition ranks the limiters the same way, so
 * adding or removing one limiter moves only the partitions that ranked it
 * first, and nobody keeps an assignment table.
 */
export const limiterFor = (
  partition: string,
  limiters: readonly string[]
): string | undefined => {
  let chosen: string | undefined;
  let highest = -1;
  for (const limiter of limiters) {
    const score = hash(`${partition}\n${limiter}`);
    if (score > highest) {
      highest = score;
      chosen = limiter;
    }
  }
  return chosen;
};

export const topologyKey = (queue: string): string => `topology/${queue}`;

const offsetDigits = 16;

/**
 * Where a partition's batch lives in the pull bucket. Offsets are padded so
 * that listing a partition's prefix returns its batches in offset order.
 */
export const pullLogKey = (
  partition: string,
  firstOffset: number,
  lastOffset: number
): string =>
  `${partition}/${String(firstOffset).padStart(offsetDigits, '0')}-${String(lastOffset).padStart(offsetDigits, '0')}`;
