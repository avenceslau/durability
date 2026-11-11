import * as v from 'valibot';
import { reportFailure, TopologyError } from '../errors.js';
import type { LifecycleHook } from '../lifecycle.js';
import { durabilityTopologyMigrations } from './migrations.js';
import { migrateCapability } from '../migrations.js';
import {
  DurabilityOutbox,
  discardWithin,
  publishNow,
  stageWithin,
  type DurabilityOutboxEvent,
  type OutboxEntry,
} from '../outbox/index.js';
import { assertPositiveInteger } from '../policy.js';
import {
  assertChannel,
  defaultChannel,
  DurabilityScheduler,
  engineFor,
  type Engine,
  type SchedulerAttachment,
} from '../scheduler/index.js';
import { canonical, deserialize, serialize } from '../serialization.js';
import { TopologyClient, type TopologyClientConfig } from './client.js';
import {
  encodeSnapshot,
  memberInputSchema,
  membersSchema,
  type TopologyMember,
  type TopologyMemberInput,
  type TopologySnapshot,
} from './snapshot.js';

/** `write` channels reach active members; `read` channels reach draining members too. */
export type TopologyRole = 'write' | 'read';

/** Publication and sync never give up: a stale topology must still converge. */
export type TopologyRetryOptions = {
  /** Maximum duration of one write or delivery. Defaults to 30 seconds. */
  attemptTimeoutMs?: number;
  retries?: {
    /** Delay in milliseconds after a failed attempt. Defaults to jittered exponential backoff capped at 5 minutes. */
    delay?: (attempt: number) => number;
  };
};

export type TopologyStateUpdate<Value> = {
  group: string;
  channel: string;
  /** Increases on every update sent to this member. Apply only versions newer than the last one applied. */
  version: number;
  topologyVersion: number;
  value: Value;
};

export type TopologyPublisher<Meta> = TopologyRetryOptions & {
  /** Must be idempotent. Store `encoded` as is: it is what the client reads. */
  write(snapshot: TopologySnapshot<Meta>, encoded: string): Promise<unknown>;
  delete(group: string, version: number): Promise<unknown>;
};

export type TopologyChannel<Value, Meta> = TopologyRetryOptions & {
  /** Defaults to `write`. */
  members?: TopologyRole;
  deliver(
    member: TopologyMember<Meta>,
    update: TopologyStateUpdate<Value>
  ): unknown;
};

/**
 * Publication and sync run on outbox channels keyed by group and by
 * `[group, member]`. On the default instance channel these are
 * `durability.topology` and `durability.topology.<state>`; on another instance
 * channel they are JSON arrays: `["durability.topology", <channel>,
 * "publication"]` and `["durability.topology", <channel>, "state", <state>]`.
 */
export type DurabilityTopologyEvent = DurabilityOutboxEvent;

export type DurabilityTopologyConfig<
  Meta,
  States extends Record<string, unknown>,
> = SchedulerAttachment &
  TopologyRetryOptions & {
    /**
     * Stable instance ID. Topologies on one scheduler share storage,
     * partitioned by channel; each owns its groups, states, publisher, and
     * deliveries, so the same group name in two channels is two groups.
     * Defaults to `default`.
     */
    channel?: string;
    /** Without a publisher, membership is only visible inside this object. */
    publish?: TopologyPublisher<Meta>;
    states?: { [Name in keyof States]: TopologyChannel<States[Name], Meta> };
    onLifecycleEvent?: (event: DurabilityTopologyEvent) => void | Promise<void>;
  };

export type TopologyCurrent<Meta, States> = {
  members: readonly TopologyMember<Meta>[];
  states: Partial<States>;
};

export type TopologyDraft<Meta, States> = {
  /** Omit to keep the current members. */
  members?: readonly TopologyMemberInput<Meta>[];
  /** Only the channels being set. */
  states?: Partial<States>;
};

type Publication<Meta> =
  | { snapshot: TopologySnapshot<Meta> }
  | { deleted: { group: string; version: number } };

type Delivery<Meta> = {
  group: string;
  member: TopologyMember<Meta>;
  topologyVersion: number;
  value: unknown;
};

type Channel<Meta> = {
  outbox: DurabilityOutbox<Delivery<Meta>>;
  role: TopologyRole;
};

const outboxChannelPrefix = 'durability.topology';

// The default instance keeps the names it used before instance channels
// existed, so outbox rows staged by an older version are still delivered.
const publicationChannelFor = (ownerChannel: string): string =>
  ownerChannel === defaultChannel
    ? outboxChannelPrefix
    : JSON.stringify([outboxChannelPrefix, ownerChannel, 'publication']);

const stateChannelFor = (ownerChannel: string, state: string): string =>
  ownerChannel === defaultChannel
    ? `${outboxChannelPrefix}.${state}`
    : JSON.stringify([outboxChannelPrefix, ownerChannel, 'state', state]);

const groupRowSchema = v.object({
  group_id: v.string(),
  version: v.pipe(v.number(), v.safeInteger(), v.gtValue(0)),
  members: v.string(),
  deleted: v.union([v.literal(0), v.literal(1)]),
});

type GroupRow = v.InferOutput<typeof groupRowSchema>;

const stateRowSchema = v.object({
  channel: v.string(),
  value: v.string(),
});

class TopologyTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`Topology ${label} timed out after ${timeoutMs}ms`);
    this.name = 'TopologyTimeoutError';
  }
}

const withTimeout = async <T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TopologyTimeoutError(label, timeoutMs)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// setTimeout overflows past this, and the outbox enforces the same ceiling.
const maxTimeoutMs = 2 ** 31 - 1;

const timeoutOf = (
  options: TopologyRetryOptions | undefined,
  fallback: TopologyRetryOptions
): number => {
  const timeoutMs =
    options?.attemptTimeoutMs ?? fallback.attemptTimeoutMs ?? 30_000;
  assertPositiveInteger('attemptTimeoutMs', timeoutMs);
  if (timeoutMs > maxTimeoutMs) {
    throw new RangeError(`attemptTimeoutMs must be at most ${maxTimeoutMs}`);
  }
  return timeoutMs;
};

/**
 * Each write or delivery has its own deadline inside a batch, so the outbox's
 * batch deadline only bounds the callback itself.
 */
const outboxOptions = (
  timeoutMs: number,
  options: TopologyRetryOptions | undefined,
  fallback: TopologyRetryOptions
) => {
  const delay = options?.retries?.delay ?? fallback.retries?.delay;
  return {
    attemptTimeoutMs: Math.min(timeoutMs * 2, maxTimeoutMs),
    ...(delay === undefined ? {} : { retries: { delay } }),
  };
};

/**
 * How long after its timeout an abandoned publisher write is assumed able to
 * land. KV has no conditional write, so some bound is required.
 */
const landingWindowMs = 5 * 60_000;

const forgetWrite = (
  sql: SqlStorage,
  ownerChannel: string,
  id: string
): void => {
  sql.exec(
    'DELETE FROM durability_topology_writes WHERE owner_channel = ? AND id = ?',
    ownerChannel,
    id
  );
};

/** Drops expired records and returns when the group's last outstanding write can no longer land. */
const outstandingWritesUntil = (
  sql: SqlStorage,
  ownerChannel: string,
  group: string,
  now: number
): number | undefined => {
  sql.exec(
    `DELETE FROM durability_topology_writes
     WHERE owner_channel = ? AND group_id = ? AND land_by <= ?`,
    ownerChannel,
    group,
    now
  );
  const { until } = v.parse(
    v.object({ until: v.nullable(v.pipe(v.number(), v.safeInteger())) }),
    sql
      .exec(
        `SELECT MAX(land_by) AS until FROM durability_topology_writes
           WHERE owner_channel = ? AND group_id = ?`,
        ownerChannel,
        group
      )
      .toArray()[0]
  );
  return until ?? undefined;
};

const assertGroup = (group: unknown): void => {
  if (typeof group !== 'string' || group.length === 0) {
    throw new TopologyError('Group must be a non-empty string');
  }
};

const deliveryKey = (group: string, member: string): string =>
  JSON.stringify([group, member]);

const isThenable = (value: unknown): boolean =>
  value !== null &&
  typeof value === 'object' &&
  typeof Reflect.get(value, 'then') === 'function';

const readGroup = (
  sql: SqlStorage,
  ownerChannel: string,
  group: string
): GroupRow | undefined =>
  v.parse(
    v.optional(groupRowSchema),
    sql
      .exec(
        `SELECT group_id, version, members, deleted
           FROM durability_topology_groups
           WHERE owner_channel = ? AND group_id = ?`,
        ownerChannel,
        group
      )
      .toArray()[0]
  );

const readStates = (sql: SqlStorage, ownerChannel: string, group: string) =>
  v.parse(
    v.array(stateRowSchema),
    sql
      .exec(
        `SELECT channel, value FROM durability_topology_states
           WHERE owner_channel = ? AND group_id = ?`,
        ownerChannel,
        group
      )
      .toArray()
  );

const parseMembers = <Meta>(row: GroupRow): TopologyMember<Meta>[] =>
  v.parse(
    membersSchema,
    JSON.parse(row.members)
  ) as unknown as TopologyMember<Meta>[];

const inRole = (member: TopologyMember<unknown>, role: TopologyRole): boolean =>
  role === 'read' || member.state === 'active';

/**
 * Experimental. Holds the membership of shard groups inside one coordinator
 * Durable Object, publishes each group's snapshot to a read store, and drives
 * every member to the latest value of each state channel. Only this instance
 * can change or publish its groups; readers use {@link DurabilityTopology.client}.
 */
export class DurabilityTopology<
  Meta = undefined,
  States extends Record<string, unknown> = Record<string, never>,
> {
  readonly #engine: Engine;
  readonly #ownerChannel: string;
  readonly #coordinator: string;
  readonly #publication: DurabilityOutbox<Publication<Meta>> | undefined;
  readonly #channels = new Map<string, Channel<Meta>>();

  constructor(config: DurabilityTopologyConfig<Meta, States>) {
    const ownerChannel = assertChannel(
      'DurabilityTopology',
      config.channel ?? defaultChannel
    );
    // The outboxes must share this helper's engine, so a private scheduler is
    // created explicitly instead of letting each attach its own.
    const scheduler = config.scheduler ?? new DurabilityScheduler(config);
    this.#engine = engineFor({ scheduler });
    const coordinator = this.#engine.objectId();
    if (coordinator === undefined) {
      throw new TopologyError(
        'DurabilityTopology needs the Durable Object context, which carries its ID'
      );
    }
    this.#ownerChannel = ownerChannel;
    this.#coordinator = coordinator;
    this.#engine.migrateSchema('topology', durabilityTopologyMigrations);

    const publisher = config.publish;
    if (
      publisher !== undefined &&
      (typeof publisher.write !== 'function' ||
        typeof publisher.delete !== 'function')
    ) {
      throw new TopologyError('publish needs write and delete functions');
    }
    const publication =
      publisher === undefined
        ? undefined
        : { publisher, timeoutMs: timeoutOf(publisher, config) };

    const states: Record<
      string,
      TopologyChannel<unknown, Meta>
    > = config.states ?? {};
    const channels = Object.entries(states).map(([name, channel]) => {
      if (!name || typeof channel.deliver !== 'function') {
        throw new TopologyError(`Invalid topology channel "${name}"`);
      }
      return {
        name,
        channel,
        timeoutMs: timeoutOf(channel, config),
      };
    });

    // Validate before claiming so config validation failures leave the channel
    // free. Even without outboxes, an instance still owns its channel's groups.
    this.#engine.claimChannel(
      'durability_topology_groups',
      ownerChannel,
      'DurabilityTopology'
    );

    // The outbox only emits outbox events, which is all this hook accepts.
    const onLifecycleEvent = config.onLifecycleEvent as
      | LifecycleHook
      | undefined;
    const lifecycle =
      onLifecycleEvent === undefined ? {} : { onLifecycleEvent };

    if (publication !== undefined) {
      const { timeoutMs } = publication;
      this.#publication = new DurabilityOutbox<Publication<Meta>>({
        scheduler,
        channel: publicationChannelFor(ownerChannel),
        ...outboxOptions(timeoutMs, publication.publisher, config),
        ...lifecycle,
        publish: (entries) =>
          this.#publishSnapshots(publication.publisher, entries, timeoutMs),
      });
    }

    for (const { name, channel, timeoutMs } of channels) {
      this.#channels.set(name, {
        role: channel.members ?? 'write',
        outbox: new DurabilityOutbox<Delivery<Meta>>({
          scheduler,
          channel: stateChannelFor(ownerChannel, name),
          ...outboxOptions(timeoutMs, channel, config),
          ...lifecycle,
          publish: (entries) =>
            this.#deliver(name, channel, entries, timeoutMs),
        }),
      });
    }
  }

  /** A read-only client for stateless Workers. It never contacts the coordinator. */
  static client<Meta = undefined>(
    config: TopologyClientConfig<Meta>
  ): TopologyClient<Meta> {
    return new TopologyClient(config);
  }

  /** Reverts only the topology tables; outbox channels migrateCapability with `DurabilityOutbox.migrate`. */
  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ) {
    return migrateCapability(
      context.storage,
      'topology',
      durabilityTopologyMigrations,
      target
    );
  }

  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#engine.alarm(info);
  }

  /**
   * Applies one change in a single transaction. `next` runs inside it and must
   * return synchronously, so nothing can interleave between reading `current`
   * and writing the draft. After the commit, one publish is attempted:
   * `published: false` means the snapshot is not yet final in the store:
   * the write failed, or an older write may still land over it. The outbox
   * keeps going until it is.
   */
  async update(
    group: string,
    next: (
      current: TopologyCurrent<Meta, States>
    ) => TopologyDraft<Meta, States>
  ): Promise<{ snapshot: TopologySnapshot<Meta>; published: boolean }> {
    assertGroup(group);
    const snapshot = await this.#engine.transaction((sql) => {
      const row = readGroup(sql, this.#ownerChannel, group);
      const live = row?.deleted === 0 ? row : undefined;
      const before = live ? parseMembers<Meta>(live) : [];
      const stateRows = readStates(sql, this.#ownerChannel, group);
      const states = Object.fromEntries(
        stateRows.map((state) => [state.channel, deserialize(state.value)])
      ) as Partial<States>;

      // A copy, so an updater that mutates `current` cannot make a change look like a no-op.
      const draft: unknown = next({ members: structuredClone(before), states });
      if (isThenable(draft)) {
        throw new TopologyError('update must return its draft synchronously');
      }
      const { members, states: changes } = this.#parseDraft(draft);
      if (!live && members === undefined) {
        throw new TopologyError(
          `Group "${group}" does not exist; set members to create it`
        );
      }

      const now = Date.now();
      const after =
        members === undefined ? before : this.#normalize(members, before, now);
      const changed =
        !live ||
        canonical(JSON.stringify(after)) !== canonical(JSON.stringify(before));
      const version = changed ? (row?.version ?? 0) + 1 : live.version;
      const current: TopologySnapshot<Meta> = {
        group,
        version,
        coordinator: this.#coordinator,
        members: after,
      };
      if (changed) {
        sql.exec(
          `INSERT INTO durability_topology_groups
             (owner_channel, group_id, version, members, deleted, updated_at)
           VALUES (?, ?, ?, ?, 0, ?)
           ON CONFLICT(owner_channel, group_id) DO UPDATE SET
             version = excluded.version,
             members = excluded.members,
             deleted = 0,
             updated_at = excluded.updated_at`,
          this.#ownerChannel,
          group,
          version,
          JSON.stringify(after),
          now
        );
        this.#stagePublication(sql, group, { snapshot: current });
      }

      const changedChannels = this.#writeStates(sql, group, changes, stateRows);
      this.#stageDeliveries(
        sql,
        group,
        version,
        before,
        after,
        changedChannels
      );
      return current;
    });

    return { snapshot, published: await this.#publishNow(group) };
  }

  /**
   * Deletes the group in one transaction: members and state values are dropped
   * and pending deliveries discarded. Versions keep counting, so a recreated
   * group is newer than anything readers cached. One publisher delete is
   * attempted after the commit.
   */
  async delete(group: string): Promise<{ published: boolean }> {
    assertGroup(group);
    await this.#engine.transaction((sql) => {
      const row = readGroup(sql, this.#ownerChannel, group);
      if (row?.deleted !== 0) {
        return;
      }
      const version = row.version + 1;
      sql.exec(
        `UPDATE durability_topology_groups
         SET version = ?, members = '[]', deleted = 1, updated_at = ?
         WHERE owner_channel = ? AND group_id = ?`,
        version,
        Date.now(),
        this.#ownerChannel,
        group
      );
      sql.exec(
        `DELETE FROM durability_topology_states
         WHERE owner_channel = ? AND group_id = ?`,
        this.#ownerChannel,
        group
      );
      for (const member of parseMembers<Meta>(row)) {
        for (const channel of this.#channels.values()) {
          discardWithin(channel.outbox, sql, deliveryKey(group, member.id));
        }
      }
      this.#stagePublication(sql, group, { deleted: { group, version } });
    });
    return { published: await this.#publishNow(group) };
  }

  /** Coordinator-local read. Readers elsewhere use the published copy. */
  snapshot(group: string): TopologySnapshot<Meta> | undefined {
    assertGroup(group);
    const row = readGroup(this.#engine.sql, this.#ownerChannel, group);
    if (row?.deleted !== 0) {
      return undefined;
    }
    return {
      group,
      version: row.version,
      coordinator: this.#coordinator,
      members: parseMembers<Meta>(row),
    };
  }

  #publishNow(group: string): Promise<boolean> {
    return this.#publication
      ? publishNow(this.#publication, group)
      : Promise.resolve(true);
  }

  #stagePublication(
    sql: SqlStorage,
    group: string,
    publication: Publication<Meta>
  ): void {
    if (this.#publication) {
      stageWithin(this.#publication, sql, group, publication);
    }
  }

  /**
   * Every write is recorded before it starts and forgotten once it settles.
   * A record that outlives its write (a timeout, or eviction mid-write) means
   * an older snapshot may still land, so a newer write is not acknowledged
   * until that record's landing deadline passes and it has been written again.
   * Records live in storage, so this survives eviction.
   */
  async #publishSnapshots(
    publisher: TopologyPublisher<Meta>,
    entries: OutboxEntry<Publication<Meta>>[],
    timeoutMs: number
  ): Promise<void> {
    const landBy = Date.now() + timeoutMs + landingWindowMs;
    const writes = entries.map((entry) => ({
      entry,
      id: crypto.randomUUID(),
    }));
    await this.#engine.transaction((sql) => {
      for (const { entry, id } of writes) {
        sql.exec(
          `INSERT INTO durability_topology_writes
             (owner_channel, id, group_id, land_by)
           VALUES (?, ?, ?, ?)`,
          this.#ownerChannel,
          id,
          entry.key,
          landBy
        );
      }
    });

    await Promise.all(
      writes.map(async ({ entry, id }) => {
        const publication = entry.value;
        const write = Promise.resolve().then(() =>
          'deleted' in publication
            ? publisher.delete(
                publication.deleted.group,
                publication.deleted.version
              )
            : publisher.write(
                publication.snapshot,
                encodeSnapshot(publication.snapshot)
              )
        );
        try {
          await withTimeout(write, timeoutMs, 'publish');
        } catch (error) {
          if (error instanceof TopologyTimeoutError) {
            this.#settleLate(entry.key, id, write);
          } else {
            // A rejected write settled before any newer write of this group started.
            await this.#engine.transaction((sql) =>
              forgetWrite(sql, this.#ownerChannel, id)
            );
          }
          reportFailure(
            'durability.topology.publish_failed',
            { group: entry.key, attempt: entry.attempt },
            error
          );
          entry.retry();
          return;
        }

        const outstandingUntil = await this.#engine.transaction((sql) => {
          forgetWrite(sql, this.#ownerChannel, id);
          return outstandingWritesUntil(
            sql,
            this.#ownerChannel,
            entry.key,
            Date.now()
          );
        });
        if (outstandingUntil !== undefined) {
          entry.retry(Math.min(outstandingUntil - Date.now(), maxTimeoutMs));
        }
      })
    );
  }

  /**
   * An abandoned write that settles while this isolate lives may have landed
   * over a newer one: forget it and restage the latest snapshot together. If
   * the isolate dies first, its record makes the next publication wait instead.
   */
  #settleLate(group: string, id: string, write: Promise<unknown>): void {
    const onError = (error: unknown) =>
      reportFailure('durability.topology.restage_failed', { group }, error);
    const settled = write
      .then(
        () => undefined,
        () => undefined
      )
      .then(() =>
        this.#engine.transaction((sql) => {
          forgetWrite(sql, this.#ownerChannel, id);
          this.#stageLatest(sql, group);
        })
      )
      .catch(onError);
    this.#engine.waitUntil(settled, onError);
  }

  /** A fresh version fences any in-flight publication, so the latest snapshot is written again. */
  #stageLatest(sql: SqlStorage, group: string): void {
    const row = readGroup(sql, this.#ownerChannel, group);
    if (!row) {
      return;
    }
    this.#stagePublication(
      sql,
      group,
      row.deleted === 1
        ? { deleted: { group, version: row.version } }
        : {
            snapshot: {
              group,
              version: row.version,
              coordinator: this.#coordinator,
              members: parseMembers<Meta>(row),
            },
          }
    );
  }

  async #deliver(
    name: string,
    channel: TopologyChannel<unknown, Meta>,
    entries: OutboxEntry<Delivery<Meta>>[],
    timeoutMs: number
  ): Promise<void> {
    await Promise.all(
      entries.map(async (entry) => {
        const { group, member, topologyVersion, value } = entry.value;
        const update: TopologyStateUpdate<unknown> = {
          group,
          channel: name,
          version: entry.version,
          topologyVersion,
          value,
        };
        try {
          // Members ignore versions they have passed, so an abandoned delivery landing late is harmless.
          await withTimeout(
            Promise.resolve().then(() => channel.deliver(member, update)),
            timeoutMs,
            'delivery'
          );
        } catch (error) {
          reportFailure(
            'durability.topology.delivery_failed',
            { group, channel: name, member: member.id, attempt: entry.attempt },
            error
          );
          entry.retry();
        }
      })
    );
  }

  #parseDraft(draft: unknown): {
    members: readonly TopologyMemberInput<Meta>[] | undefined;
    states: Record<string, unknown>;
  } {
    if (draft === null || typeof draft !== 'object') {
      throw new TopologyError('update must return a draft object');
    }
    const members: unknown = Reflect.get(draft, 'members');
    const states: unknown = Reflect.get(draft, 'states') ?? {};
    if (members !== undefined && !Array.isArray(members)) {
      throw new TopologyError('Draft members must be an array');
    }
    if (
      states === null ||
      typeof states !== 'object' ||
      Array.isArray(states)
    ) {
      throw new TopologyError('Draft states must be an object');
    }
    return {
      members: members as readonly TopologyMemberInput<Meta>[] | undefined,
      states: states as Record<string, unknown>,
    };
  }

  #normalize(
    inputs: readonly TopologyMemberInput<Meta>[],
    before: readonly TopologyMember<Meta>[],
    now: number
  ): TopologyMember<Meta>[] {
    if (inputs.length === 0) {
      throw new TopologyError(
        'A group needs at least one member; use delete() to remove it'
      );
    }
    const joinedAt = new Map(
      before.map((member) => [member.id, member.joinedAt])
    );
    const seen = new Set<string>();
    const members = inputs.map((input) => {
      const parsed = v.safeParse(memberInputSchema, input);
      if (!parsed.success) {
        throw new TopologyError(
          `Invalid member: ${v.summarize(parsed.issues)}`
        );
      }
      const { id, state, locationHint, meta } = parsed.output;
      if (seen.has(id)) {
        throw new TopologyError(`Duplicate member "${id}"`);
      }
      seen.add(id);
      return {
        id,
        state,
        ...(locationHint === undefined ? {} : { locationHint }),
        ...(meta === undefined ? {} : { meta }),
        joinedAt: joinedAt.get(id) ?? now,
      } as unknown as TopologyMember<Meta>;
    });
    return members.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Returns the channels whose value changed. Unchanged values are not redelivered. */
  #writeStates(
    sql: SqlStorage,
    group: string,
    changes: Record<string, unknown>,
    current: v.InferOutput<typeof stateRowSchema>[]
  ): Set<string> {
    const existing = new Map(current.map((row) => [row.channel, row.value]));
    const changed = new Set<string>();
    for (const [channel, value] of Object.entries(changes)) {
      if (value === undefined) {
        continue;
      }
      if (!this.#channels.has(channel)) {
        throw new TopologyError(`Unknown topology channel "${channel}"`);
      }
      const stored = serialize(value);
      const previous = existing.get(channel);
      if (previous !== undefined && canonical(previous) === canonical(stored)) {
        continue;
      }
      sql.exec(
        `INSERT INTO durability_topology_states
           (owner_channel, group_id, channel, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_channel, group_id, channel) DO UPDATE SET
           value = excluded.value`,
        this.#ownerChannel,
        group,
        channel,
        stored
      );
      changed.add(channel);
    }
    return changed;
  }

  /**
   * Members that entered a channel's role receive its current value; a changed
   * value goes to every member in the role. Members that left lose their
   * pending delivery.
   */
  #stageDeliveries(
    sql: SqlStorage,
    group: string,
    topologyVersion: number,
    before: readonly TopologyMember<Meta>[],
    after: readonly TopologyMember<Meta>[],
    changed: ReadonlySet<string>
  ): void {
    const values = new Map(
      readStates(sql, this.#ownerChannel, group).map((row) => [
        row.channel,
        row.value,
      ])
    );
    for (const [name, channel] of this.#channels) {
      const previous = new Set(
        before
          .filter((member) => inRole(member, channel.role))
          .map(({ id }) => id)
      );
      const targets = after.filter((member) => inRole(member, channel.role));
      const kept = new Set(targets.map(({ id }) => id));
      for (const id of previous) {
        if (!kept.has(id)) {
          discardWithin(channel.outbox, sql, deliveryKey(group, id));
        }
      }

      const value = values.get(name);
      if (value === undefined) {
        continue;
      }
      for (const member of targets) {
        if (!changed.has(name) && previous.has(member.id)) {
          continue;
        }
        stageWithin(channel.outbox, sql, deliveryKey(group, member.id), {
          group,
          member,
          topologyVersion,
          value: deserialize(value),
        });
      }
    }
  }
}
