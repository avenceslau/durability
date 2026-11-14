import { DurableObject, env } from 'cloudflare:workers';
import type { PullBatch } from './model';
import type { Delivery } from './targets';

type PartitionRow = {
  epoch: number;
  partition: number;
  /** Key of the last batch the consumer acknowledged. */
  position: string | null;
  lease: string | null;
  /** Key of the last batch the lease covers. */
  lease_through: string | null;
  lease_expires_at: number | null;
  attempt: number;
  checked_at: number;
};

export type PullOptions = {
  /** Stored batches to hand out at once, each up to 100 messages. */
  batches?: number;
  /** How long the consumer has to acknowledge before the messages are handed out again. */
  visibilityMs?: number;
};

const defaultBatches = 10;
const maxBatches = 100;
const defaultVisibilityMs = 30_000;
/** A partition found empty is not listed again for this long. */
const emptyRecheckMs = 1_000;
/** Epochs and partitions are looked up in the bucket at most this often. */
const discoveryMs = 2_000;

/** The names directly under a prefix, as numbers: epochs of a queue, or partitions of an epoch. */
const numbersUnder = async (prefix: string): Promise<number[]> => {
  const numbers: number[] = [];
  let cursor: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await env.PULL.list({
      prefix,
      delimiter: '/',
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const name of page.delimitedPrefixes) {
      numbers.push(Number(name.slice(prefix.length, -1)));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return numbers.sort((a, b) => a - b);
};

/**
 * One pull consumer of one queue. It reads the batches the queue's partitions
 * wrote to the pull bucket and remembers how far the consumer got in each
 * partition, so pulling takes nothing from the partitions themselves.
 *
 * Order is kept the way delivery keeps it: one partition hands out one range
 * at a time, and an epoch is finished before the next one is read.
 */
export class PullConsumer extends DurableObject<Cloudflare.Env> {
  private readonly sql = this.ctx.storage.sql;
  private readonly kv = this.ctx.storage.kv;
  /** Partitions a pull is reading right now, so two pulls never take the same one. */
  private readonly reading = new Set<number>();
  private discoveredAt = 0;

  constructor(ctx: DurableObjectState, bindings: Cloudflare.Env) {
    super(ctx, bindings);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS partitions (
         epoch INTEGER NOT NULL,
         partition INTEGER NOT NULL,
         position TEXT,
         lease TEXT,
         lease_through TEXT,
         lease_expires_at INTEGER,
         attempt INTEGER NOT NULL DEFAULT 0,
         checked_at INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (epoch, partition)
       )`
    );
  }

  /**
   * Hands out the next messages of one partition, or nothing when the
   * consumer has caught up. The messages are the consumer's until it
   * acknowledges them or the lease runs out.
   */
  async pull(
    queue: string,
    options: PullOptions = {}
  ): Promise<PullBatch | undefined> {
    await this.discover(queue);
    const epoch = this.kv.get<number>('epoch');
    if (epoch === undefined) {
      return undefined;
    }

    const now = Date.now();
    // Least recently checked first, so every partition gets its turn.
    const candidates = this.sql
      .exec<PartitionRow>(
        `SELECT * FROM partitions
         WHERE epoch = ?
           AND (lease IS NULL OR lease_expires_at <= ?)
           AND checked_at <= ?
         ORDER BY checked_at`,
        epoch,
        now,
        now - emptyRecheckMs
      )
      .toArray();

    for (const row of candidates) {
      if (this.reading.has(row.partition)) {
        continue;
      }
      this.reading.add(row.partition);
      try {
        // eslint-disable-next-line no-await-in-loop
        const batch = await this.read(queue, row, options);
        if (batch) {
          return batch;
        }
      } finally {
        this.reading.delete(row.partition);
      }
    }
    return undefined;
  }

  /** Moves the consumer past the leased messages. False when the lease is no longer the current one. */
  ack(lease: string): boolean {
    return (
      this.sql.exec(
        `UPDATE partitions
         SET position = lease_through,
             lease = NULL,
             lease_through = NULL,
             lease_expires_at = NULL,
             attempt = 0
         WHERE lease = ?`,
        lease
      ).rowsWritten > 0
    );
  }

  /** Gives the leased messages back, to be handed out again at once. */
  nack(lease: string): boolean {
    return (
      this.sql.exec(
        `UPDATE partitions
         SET lease = NULL, lease_through = NULL, lease_expires_at = NULL
         WHERE lease = ?`,
        lease
      ).rowsWritten > 0
    );
  }

  /**
   * Finds the epoch to read and its partitions by listing the bucket.
   *
   * A queue's partitions write to a new epoch only after the previous one is
   * completely written, so a later epoch in the bucket means the current one
   * will get nothing more. It is left once every partition has been listed
   * empty after that became known.
   */
  private async discover(queue: string): Promise<void> {
    const now = Date.now();
    if (now - this.discoveredAt < discoveryMs) {
      return;
    }
    this.discoveredAt = now;

    const epochs = await numbersUnder(`${queue}/`);
    const current = this.kv.get<number>('epoch') ?? epochs[0];
    if (current === undefined) {
      return;
    }
    const later = epochs.find((candidate) => candidate > current);
    const epoch =
      later !== undefined && this.finished(current) ? later : current;
    if (epoch !== current) {
      this.sql.exec('DELETE FROM partitions WHERE epoch = ?', current);
      this.kv.delete('closedAt');
    } else if (later !== undefined && this.kv.get('closedAt') === undefined) {
      // Taken after the listing: only a partition listed empty from now on
      // is known to have nothing more coming.
      this.kv.put('closedAt', Date.now());
    }
    this.kv.put('epoch', epoch);

    for (const partition of await numbersUnder(`${queue}/${epoch}/`)) {
      this.sql.exec(
        'INSERT OR IGNORE INTO partitions (epoch, partition) VALUES (?, ?)',
        epoch,
        partition
      );
    }
  }

  /** True once the epoch is closed and every partition was listed empty after that. */
  private finished(epoch: number): boolean {
    const closedAt = this.kv.get<number>('closedAt');
    if (closedAt === undefined) {
      return false;
    }
    const unfinished = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM partitions
         WHERE epoch = ? AND (lease IS NOT NULL OR checked_at <= ?)`,
        epoch,
        closedAt
      )
      .one().count;
    return unfinished === 0;
  }

  private async read(
    queue: string,
    row: PartitionRow,
    options: PullOptions
  ): Promise<PullBatch | undefined> {
    const partition = `${queue}/${row.epoch}/${row.partition}`;
    const checkedAt = Date.now();
    const page = await env.PULL.list({
      prefix: `${partition}/`,
      limit: Math.min(options.batches ?? defaultBatches, maxBatches),
      ...(row.position === null ? {} : { startAfter: row.position }),
    });
    const last = page.objects[page.objects.length - 1];
    if (!last) {
      this.sql.exec(
        'UPDATE partitions SET checked_at = ? WHERE epoch = ? AND partition = ?',
        checkedAt,
        row.epoch,
        row.partition
      );
      return undefined;
    }

    const stored = await Promise.all(
      page.objects.map((object) => env.PULL.get(object.key))
    );
    const batches = await Promise.all(
      stored
        .filter((object) => object !== null)
        .map((object) => object.json<Delivery>())
    );

    // Bodies were stored as JSON, so that is what they are.
    const messages = batches.flatMap(
      (delivery) => delivery.messages
    ) as PullBatch['messages'];
    if (messages.length === 0) {
      // Retention removed the batches between the listing and the read.
      this.sql.exec(
        'UPDATE partitions SET position = ? WHERE epoch = ? AND partition = ?',
        last.key,
        row.epoch,
        row.partition
      );
      return undefined;
    }

    // A lease that ran out is handed out again under a new name, so the
    // consumer that held it can no longer acknowledge it.
    const batch: PullBatch = {
      lease: crypto.randomUUID(),
      partition,
      attempt: row.attempt + 1,
      expiresAt: Date.now() + (options.visibilityMs ?? defaultVisibilityMs),
      messages,
    };
    this.sql.exec(
      `UPDATE partitions
       SET lease = ?, lease_through = ?, lease_expires_at = ?, attempt = ?
       WHERE epoch = ? AND partition = ?`,
      batch.lease,
      last.key,
      batch.expiresAt,
      batch.attempt,
      row.epoch,
      row.partition
    );
    return batch;
  }
}
