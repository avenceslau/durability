import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopologyError } from '../errors';
import { DurabilityOutbox } from '../outbox';
import { serialize } from '../serialization';
import { contextFor, FakeStorage } from '../test-fakes';
import { DurabilityTopology, type TopologyStateUpdate } from './index';
import { decodeSnapshot, type TopologyMember } from './snapshot';

type States = { limits: { max: number } };

const coordinatorId = 'coordinator-1';
const beforeChannels = 'durability_0011_create_topology';

class Store {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ group: string; version: number }> = [];
  readonly deletes: Array<{ group: string; version: number }> = [];
  hang = false;

  readonly publisher = {
    write: async (
      snapshot: { group: string; version: number },
      encoded: string
    ) => {
      if (this.hang) {
        await new Promise(() => undefined);
      }
      this.writes.push({ group: snapshot.group, version: snapshot.version });
      this.values.set(snapshot.group, encoded);
    },
    delete: async (group: string, version: number) => {
      this.deletes.push({ group, version });
      this.values.delete(group);
    },
  };
}

class Members {
  readonly applied: Array<{ member: string; value: unknown }> = [];
  hang = false;

  readonly deliver = async (
    member: TopologyMember,
    update: TopologyStateUpdate<unknown>
  ) => {
    if (this.hang) {
      await new Promise(() => undefined);
    }
    this.applied.push({ member: member.id, value: update.value });
  };
}

const active = (id: string) => ({ id, state: 'active' as const });

const contextOf = (storage: FakeStorage) =>
  ({ ...contextFor(storage), id: coordinatorId }) as never;

const instance = (
  context: never,
  channel: string | undefined,
  store = new Store(),
  members = new Members()
) => ({
  store,
  members,
  topology: new DurabilityTopology<undefined, States>({
    context,
    ...(channel === undefined ? {} : { channel }),
    retries: { delay: () => 1_000 },
    publish: { ...store.publisher, attemptTimeoutMs: 100 },
    states: {
      limits: {
        deliver: members.deliver,
      },
    },
  }),
});

const outboxChannels = (storage: FakeStorage) =>
  storage.sql
    .exec('SELECT DISTINCT channel FROM durability_outbox ORDER BY channel')
    .toArray()
    .map((row) => row['channel']);

const settle = async () => {
  for (let index = 0; index < 5; index++) {
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(0);
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('topology instance channels', () => {
  it('keeps the same group and state names apart across instances', async () => {
    const storage = new FakeStorage();
    const context = contextOf(storage);
    const app = instance(context, undefined);
    const library = instance(context, 'library');

    await app.topology.update('acme', () => ({
      members: [active('app-0')],
      states: {
        limits: {
          max: 1,
        },
      },
    }));
    await library.topology.update('acme', () => ({
      members: [active('library-0'), active('library-1')],
      states: {
        limits: {
          max: 2,
        },
      },
    }));
    await settle();
    await library.topology.update('acme', ({ members }) => ({
      members: members.slice(1),
    }));
    await settle();

    expect(app.topology.snapshot('acme')).toMatchObject({
      version: 1,
      members: [{ id: 'app-0' }],
    });
    expect(library.topology.snapshot('acme')).toMatchObject({
      version: 2,
      members: [{ id: 'library-1' }],
    });
    expect(decodeSnapshot(app.store.values.get('acme')!).version).toBe(1);
    expect(decodeSnapshot(library.store.values.get('acme')!).version).toBe(2);
    expect(app.members.applied).toEqual([
      {
        member: 'app-0',
        value: { max: 1 },
      },
    ]);
    expect(library.members.applied).toEqual([
      {
        member: 'library-0',
        value: { max: 2 },
      },
      {
        member: 'library-1',
        value: { max: 2 },
      },
    ]);

    await app.topology.update('acme', () => ({
      states: {
        limits: {
          max: 1,
        },
      },
    }));
    await settle();
    expect(app.members.applied).toHaveLength(1);
  });

  it('deletes and versions each instance group independently', async () => {
    const storage = new FakeStorage();
    const context = contextOf(storage);
    const app = instance(context, undefined);
    const library = instance(context, 'library');
    await app.topology.update('acme', () => ({ members: [active('a')] }));
    await library.topology.update('acme', () => ({ members: [active('b')] }));

    expect(await library.topology.delete('acme')).toEqual({ published: true });
    expect(library.store.deletes).toEqual([{ group: 'acme', version: 2 }]);
    expect(app.store.deletes).toEqual([]);
    expect(library.topology.snapshot('acme')).toBeUndefined();
    expect(app.topology.snapshot('acme')?.members).toMatchObject([{ id: 'a' }]);

    const recreated = await library.topology.update('acme', () => ({
      members: [active('c')],
    }));
    expect(recreated.snapshot.version).toBe(3);
    expect(app.topology.snapshot('acme')?.version).toBe(1);
  });

  it('fences stale writes only within their own instance', async () => {
    const storage = new FakeStorage();
    const context = contextOf(storage);
    const app = instance(context, undefined);
    const library = instance(context, 'library');

    app.store.hang = true;
    const first = app.topology.update('acme', () => ({
      members: [active('a')],
    }));
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).published).toBe(false);

    const other = await library.topology.update('acme', () => ({
      members: [active('b')],
    }));
    expect(other.published).toBe(true);

    app.store.hang = false;
    const blocked = await app.topology.update('acme', ({ members }) => ({
      members: [...members, active('c')],
    }));
    expect(blocked.published).toBe(false);
    expect(
      storage.sql
        .exec('SELECT owner_channel, group_id FROM durability_topology_writes')
        .toArray()
    ).toEqual([{ owner_channel: 'default', group_id: 'acme' }]);
  });

  it('rejects a second instance on a channel, even without a publisher', () => {
    const storage = new FakeStorage();
    const context = contextOf(storage);
    expect(
      () =>
        new DurabilityTopology({
          context,
          channel: 'library',
          states: { limits: { deliver: 'nope' } as never },
        })
    ).toThrow(TopologyError);
    const library = new DurabilityTopology({ context, channel: 'library' });
    expect(library.snapshot('acme')).toBeUndefined();
    expect(
      () => new DurabilityTopology({ context, channel: 'library' })
    ).toThrow('DurabilityTopology for channel "library" is already attached');
    const app = new DurabilityTopology({ context });
    expect(app.snapshot('acme')).toBeUndefined();
    expect(() => new DurabilityTopology({ context })).toThrow(
      'already attached'
    );
    expect(() => new DurabilityTopology({ context, channel: '' })).toThrow(
      'channel must be a non-empty string'
    );
  });

  it('derives internal outbox channels that cannot collide', async () => {
    const storage = new FakeStorage();
    const context = contextOf(storage);
    const dotted = new Members();
    const nested = new Members();
    const createTopology = (channel: string, state: string, members: Members) =>
      new DurabilityTopology<undefined, Record<string, unknown>>({
        context,
        channel,
        publish: new Store().publisher,
        states: {
          [state]: {
            deliver: members.deliver,
          },
        },
      });
    const first = createTopology('a', 'b.c', dotted);
    const second = createTopology('a.b', 'c', nested);
    const legacy = instance(context, undefined);

    await first.update('g', () => ({
      members: [active('m')],
      states: { 'b.c': 1 },
    }));
    await second.update('g', () => ({
      members: [active('m')],
      states: { c: 2 },
    }));
    await legacy.topology.update('g', () => ({
      members: [active('m')],
      states: { limits: { max: 3 } },
    }));
    await settle();

    expect(dotted.applied).toEqual([{ member: 'm', value: 1 }]);
    expect(nested.applied).toEqual([{ member: 'm', value: 2 }]);
    expect(legacy.members.applied).toEqual([
      { member: 'm', value: { max: 3 } },
    ]);
  });

  it('names default outbox channels as before and named ones as JSON tuples', async () => {
    const storage = new FakeStorage();
    const context = contextOf(storage);
    const app = instance(context, undefined);
    const library = instance(context, 'library');
    for (const { store, members } of [app, library]) {
      store.hang = true;
      members.hang = true;
    }
    void app.topology.update('acme', () => ({
      members: [active('a')],
      states: { limits: { max: 1 } },
    }));
    void library.topology.update('acme', () => ({
      members: [active('a')],
      states: { limits: { max: 1 } },
    }));
    await settle();

    expect(outboxChannels(storage)).toEqual([
      '["durability.topology","library","publication"]',
      '["durability.topology","library","state","limits"]',
      'durability.topology',
      'durability.topology.limits',
    ]);
  });

  it('keeps a missing instance outbox rows for that instance only', async () => {
    const storage = new FakeStorage();
    const evicted = new Store();
    evicted.hang = true;
    // A retry delay past alarmMinDelayMs leaves retries to the physical
    // alarm, which nothing fires, as if this object had been evicted.
    const library = new DurabilityTopology<undefined, States>({
      context: contextOf(storage),
      channel: 'library',
      retries: { delay: () => 60_000 },
      publish: { ...evicted.publisher, attemptTimeoutMs: 100 },
    });
    void library.update('acme', () => ({ members: [active('a')] }));
    await vi.advanceTimersByTimeAsync(100);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const app = instance(contextOf(storage), undefined);
    await vi.advanceTimersByTimeAsync(120_000);
    await app.topology.alarm();
    await settle();

    expect(app.store.writes).toEqual([]);
    expect(outboxChannels(storage)).toEqual([
      '["durability.topology","library","publication"]',
    ]);

    const returned = instance(contextOf(storage), 'library');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await returned.topology.alarm();
    await settle();
    expect(returned.store.writes).toEqual([{ group: 'acme', version: 1 }]);
    expect(app.store.writes).toEqual([]);
  });

  it('migrates legacy groups, states, writes, and pending publications to the default instance', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    DurabilityTopology.migrate(context, beforeChannels);
    DurabilityOutbox.migrate(context);
    const member = { id: 'a', state: 'active', joinedAt: 1 };
    const snapshot = {
      group: 'acme',
      version: 4,
      coordinator: coordinatorId,
      members: [member],
    };
    storage.sql.exec(
      `INSERT INTO durability_topology_groups VALUES ('acme', 4, ?, 0, 1)`,
      JSON.stringify([member])
    );
    storage.sql.exec(
      `INSERT INTO durability_topology_states VALUES ('acme', 'limits', ?)`,
      serialize({ max: 7 })
    );
    storage.sql.exec(
      `INSERT INTO durability_topology_writes VALUES ('w', 'acme', 0)`
    );
    const pending = [
      ['durability.topology', 'acme', { snapshot }],
      [
        'durability.topology.limits',
        JSON.stringify(['acme', 'a']),
        {
          group: 'acme',
          member,
          topologyVersion: 4,
          value: { max: 7 },
        },
      ],
    ] as const;
    for (const [index, [channel, key, value]] of pending.entries()) {
      storage.sql.exec(
        `INSERT INTO durability_outbox
         (id, channel, entry_key, version, payload, status, attempt,
          next_attempt_at, created_at, generation_id)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?)`,
        JSON.stringify([channel, key]),
        channel,
        key,
        index + 1,
        serialize(value),
        String(index + 1)
      );
    }
    storage.sql.exec('UPDATE durability_outbox_seq SET next_version = 3');

    const app = instance(contextOf(storage), undefined);
    await app.topology.alarm();
    await settle();

    expect(app.store.writes).toEqual([{ group: 'acme', version: 4 }]);
    expect(app.members.applied).toEqual([{ member: 'a', value: { max: 7 } }]);
    expect(app.topology.snapshot('acme')).toEqual(snapshot);
    expect(
      storage.sql
        .exec('SELECT owner_channel, id FROM durability_topology_writes')
        .toArray()
    ).toEqual([]);
    const grown = await app.topology.update('acme', ({ members }) => ({
      members: [...members, active('b')],
      states: { limits: { max: 7 } },
    }));
    expect(grown.snapshot.version).toBe(5);
    await settle();
    expect(app.members.applied).toEqual([
      { member: 'a', value: { max: 7 } },
      { member: 'b', value: { max: 7 } },
    ]);
  });

  it('refuses a downgrade that would drop named instance data', async () => {
    const storage = new FakeStorage();
    const context = contextOf(storage);
    const app = instance(context, undefined);
    const library = instance(context, 'library');
    await app.topology.update('acme', () => ({
      members: [active('a')],
      states: { limits: { max: 1 } },
    }));
    await library.topology.update('acme', () => ({ members: [active('b')] }));
    await library.topology.delete('acme');

    expect(() => DurabilityTopology.migrate(context, beforeChannels)).toThrow(
      /cannot_downgrade_nondefault_channels/
    );
    expect(
      storage.sql
        .exec(
          'SELECT owner_channel, deleted FROM durability_topology_groups ORDER BY owner_channel'
        )
        .toArray()
    ).toEqual([
      { owner_channel: 'default', deleted: 0 },
      { owner_channel: 'library', deleted: 1 },
    ]);

    storage.sql.exec(
      "DELETE FROM durability_topology_groups WHERE owner_channel = 'library'"
    );
    expect(
      DurabilityTopology.migrate(context, beforeChannels).rolledBack
    ).toEqual(['durability_0022_topology_channels']);
    expect(
      storage.sql.exec('SELECT * FROM durability_topology_groups').toArray()
    ).toMatchObject([{ group_id: 'acme', version: 1, deleted: 0 }]);
    expect(
      storage.sql.exec('SELECT * FROM durability_topology_states').toArray()
    ).toEqual([
      { group_id: 'acme', channel: 'limits', value: serialize({ max: 1 }) },
    ]);
  });
});
