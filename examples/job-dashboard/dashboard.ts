/**
 * Hub of the `job-dashboard` example. Three kinds of peers talk to it:
 *
 * - Browsers, over `DurabilitySocket`. `work` serves `tracker.records()` as
 *   the snapshot (plain JSON, no functions); every ingested change is pushed
 *   as a `job` event, which the socket persists and replays after reconnects.
 *   `importOrder` starts a job on the tenant's `Pipeline` and waits for its
 *   result through a tracker handle, in one pipelined RPC round trip.
 * - The tenant's `Pipeline`, through fanout deliveries into `ingest`.
 *
 * The ingested table is itself a `TrackedSource`, so `this.tracker.get` also
 * works locally: its `watch` is settled by `ingest`.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  DurabilityTracker,
  type TrackedRecord,
  type TrackedSource,
  type TrackedStatus,
} from 'durability/experimental';
import { DurabilitySocket, event } from 'durability/socket';
import { z } from 'zod';
import type { Env, JobEvent, Jobs } from './shared';

type JobRow = {
  id: string;
  name: string;
  generation: string;
  created_at: number;
  status: string;
  state: string;
};

const toRecord = (row: JobRow): TrackedRecord<Jobs> => ({
  id: row.id,
  name: 'importOrder',
  generation: row.generation,
  createdAt: row.created_at,
  state: JSON.parse(row.state),
});

const workQuery = z.object({
  cursor: z.string().optional(),
  status: z.enum(['pending', 'completed', 'failed']).optional(),
});

export class Dashboard extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;
  private readonly watchers = new Map<
    string,
    Set<(settled?: TrackedRecord<Jobs>) => void>
  >();

  /** The ingested table, read through the tracker's source contract. */
  private readonly jobs: TrackedSource<Jobs> = {
    get: async (id) => {
      const row = this.readRow(id);
      return row && toRecord(row);
    },
    list: async ({ limit, cursor, status, name }) => {
      const [createdAt, afterId] =
        cursor === undefined
          ? [-1, '']
          : (JSON.parse(cursor) as [number, string]);
      const rows = this.sql
        .exec<JobRow>(
          `SELECT * FROM jobs
           WHERE (? IS NULL OR status = ?)
             AND (? IS NULL OR name = ?)
             AND (created_at > ? OR (created_at = ? AND id > ?))
           ORDER BY created_at, id
           LIMIT ?`,
          status ?? null,
          status ?? null,
          name ?? null,
          name ?? null,
          createdAt,
          createdAt,
          afterId,
          limit + 1
        )
        .toArray();
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const records = page.map(toRecord);
      return rows.length > limit && last
        ? { records, cursor: JSON.stringify([last.created_at, last.id]) }
        : { records };
    },
    watch: (id, listener) => {
      const listeners = this.watchers.get(id) ?? new Set();
      this.watchers.set(id, listeners.add(listener));
      return () => {
        listeners.delete(listener);
      };
    },
  };

  private readonly tracker = new DurabilityTracker({
    sources: { jobs: this.jobs },
  });

  readonly socket = new DurabilitySocket({
    context: this.ctx,
    inbound: {
      importOrder: {
        input: z.string().min(1),
        handle: async (orderId: string) => {
          const pipeline = this.env.PIPELINE.getByName(this.tenant);
          await pipeline.importOrder(orderId);
          return pipeline.track(orderId).wait({ timeoutMs: 30_000 });
        },
      },
      work: {
        input: workQuery,
        handle: (query: {
          cursor?: string | undefined;
          status?: TrackedStatus | undefined;
        }) => this.tracker.records(query),
      },
    },
    outbound: { job: event<TrackedRecord<Jobs>>() },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS jobs (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         generation TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         status TEXT NOT NULL,
         state TEXT NOT NULL
       )`
    );
  }

  private get tenant(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  /** Called by the pipeline's fanout. Returning without throwing acks the batch. */
  ingest(events: JobEvent[]): void {
    for (const job of events) {
      // Deliveries can arrive out of order on retry: a late `pending` must not
      // overwrite a settled row of the same generation.
      this.sql.exec(
        `INSERT INTO jobs (id, name, generation, created_at, status, state)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           generation = excluded.generation,
           created_at = excluded.created_at,
           status = excluded.status,
           state = excluded.state
         WHERE excluded.generation != jobs.generation OR jobs.status = 'pending'`,
        job.id,
        job.name,
        job.generation,
        job.createdAt,
        job.state.status,
        JSON.stringify(job.state)
      );
      const row = this.readRow(job.id);
      if (!row) {
        continue;
      }
      const record = toRecord(row);
      this.socket.job(record);
      for (const listener of this.watchers.get(job.id) ?? []) {
        listener();
      }
    }
  }

  private readRow(id: string): JobRow | undefined {
    return this.sql
      .exec<JobRow>('SELECT * FROM jobs WHERE id = ?', id)
      .toArray()[0];
  }

  override fetch(request: Request) {
    return this.socket.fetch(request);
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    return this.socket.webSocketMessage(ws, message);
  }

  override webSocketClose(ws: WebSocket) {
    this.socket.webSocketClose(ws);
  }
}
