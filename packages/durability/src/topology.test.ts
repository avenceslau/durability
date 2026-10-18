import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopologyError, TopologyUnavailableError } from './errors';
import {
  DurabilityTopology,
  type DurabilityTopologyConfig,
  type DurabilityTopologyEvent,
  type TopologyStateUpdate,
} from './topology';
import {
  decodeSnapshot,
  encodeSnapshot,
  type TopologyMember,
} from './topology-snapshot';
import { FakeStorage } from './test-fakes';

type Limits = { max: number };
type States = { limits: Limits; config: string };

const coordinatorId = 'coordinator-1';

class Store {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ group: string; version: number }> = [];
  readonly deletes: Array<{ group: string; version: number }> = [];
  fail = false;

  readonly publisher = {
    write: async (
      snapshot: { group: string; version: number },
      encoded: string
    ) => {
      if (this.fail) {
        throw new Error('store unavailable');
      }
      this.writes.push({ group: snapshot.group, version: snapshot.version });
      this.values.set(snapshot.group, encoded);
    },
    delete: async (group: string, version: number) => {
      if (this.fail) {
        throw new Error('store unavailable');
      }
      this.deletes.push({ group, version });
      this.values.delete(group);
    },
  };

  read = async (group: string) => this.values.get(group) ?? null;
}

class Members {
  readonly applied = new Map<string, Array<TopologyStateUpdate<unknown>>>();
  readonly failing = new Set<string>();

  readonly deliver = async (
    member: TopologyMember,
    update: TopologyStateUpdate<unknown>
  ) => {
    if (this.failing.has(member.id)) {
      throw new Error(`${member.id} unavailable`);
    }
    const updates = this.applied.get(member.id) ?? [];
    updates.push(update);
    this.applied.set(member.id, updates);
  };

  values(id: string, channel = 'limits'): unknown[] {
    return (this.applied.get(id) ?? [])
      .filter((update) => update.channel === channel)
      .map((update) => update.value);
  }
}

const settle = async () => {
  for (let index = 0; index < 5; index++) {
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(0);
  }
};

const fixture = () => {
  const storage = new FakeStorage();
  const store = new Store();
  const members = new Members();
  const events: DurabilityTopologyEvent[] = [];
  const context = {
    storage: storage as unknown as DurableObjectStorage,
    id: { toString: () => coordinatorId },
  };
  const config: DurabilityTopologyConfig<undefined, States> = {
    context,
    publish: store.publisher,
    retries: { delay: () => 1_000 },
    states: {
      limits: { deliver: members.deliver },
      config: { deliver: members.deliver, members: 'read' },
    },
    onLifecycleEvent: (event) => {
      events.push(event);
    },
  };
  const topology = new DurabilityTopology<undefined, States>(config);
  const client = DurabilityTopology.client({ read: store.read });
  return { storage, store, members, events, config, topology, client };
};

const active = (id: string) => ({ id, state: 'active' as const });

const slowPublishConfig = (store: Store) => ({
  context: {
    storage: new FakeStorage() as unknown as DurableObjectStorage,
    id: coordinatorId,
  } as never,
  publish: { ...store.publisher, attemptTimeoutMs: 100 },
  retries: { delay: () => 60_000 },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DurabilityTopology', () => {
  it('commits members and states together and publishes before returning', async () => {
    const { topology, client, store } = fixture();

    const result = await topology.update('acme', () => ({
      members: [active('acme-1'), active('acme-0')],
      states: { limits: { max: 5 } },
    }));

    expect(result.published).toBe(true);
    expect(result.snapshot).toMatchObject({
      group: 'acme',
      version: 1,
      coordinator: coordinatorId,
      members: [
        { id: 'acme-0', state: 'active', joinedAt: 1_800_000_000_000 },
        { id: 'acme-1', state: 'active' },
      ],
    });
    expect(store.writes).toEqual([{ group: 'acme', version: 1 }]);
    expect(topology.snapshot('acme')).toEqual(result.snapshot);
    expect(await client.get('acme')).toMatchObject({
      ...result.snapshot,
      source: 'published',
    });
  });

  it('refuses to construct without the Durable Object ID', () => {
    const storage = new FakeStorage();
    expect(
      () =>
        new DurabilityTopology({
          context: { storage: storage as unknown as DurableObjectStorage },
        })
    ).toThrow(TopologyError);
  });

  it('keeps the version and joinedAt when membership does not change', async () => {
    const { topology, store } = fixture();
    await topology.update('acme', () => ({ members: [active('acme-0')] }));
    vi.advanceTimersByTime(5_000);

    const same = await topology.update('acme', ({ members }) => ({
      members: [...members],
    }));
    expect(same.snapshot.version).toBe(1);
    expect(store.writes).toHaveLength(1);

    const grown = await topology.update('acme', ({ members }) => ({
      members: [...members, active('acme-1')],
    }));
    expect(grown.snapshot.version).toBe(2);
    expect(grown.snapshot.members).toEqual([
      { id: 'acme-0', state: 'active', joinedAt: 1_800_000_000_000 },
      { id: 'acme-1', state: 'active', joinedAt: 1_800_000_005_000 },
    ]);
  });

  it('rejects invalid drafts without committing anything', async () => {
    const { topology } = fixture();
    await expect(
      topology.update('acme', () => ({ states: { limits: { max: 1 } } }))
    ).rejects.toThrow('does not exist');
    await expect(
      topology.update('acme', () => ({ members: [] }))
    ).rejects.toThrow('use delete()');
    await expect(
      topology.update('acme', () => ({
        members: [active('a'), active('a')],
      }))
    ).rejects.toThrow('Duplicate member');
    await expect(
      topology.update('acme', (async () => ({
        members: [active('a')],
      })) as never)
    ).rejects.toThrow('synchronously');
    await expect(
      topology.update('acme', () => ({
        members: [active('a')],
        states: { unknown: 1 } as never,
      }))
    ).rejects.toThrow('Unknown topology channel');
    expect(topology.snapshot('acme')).toBeUndefined();
  });

  it('reports a failed publish and retries it from the outbox', async () => {
    const { topology, store } = fixture();
    store.fail = true;

    const result = await topology.update('acme', () => ({
      members: [active('acme-0')],
    }));
    expect(result.published).toBe(false);
    expect(topology.snapshot('acme')?.version).toBe(1);

    store.fail = false;
    vi.advanceTimersByTime(1_000);
    await topology.alarm();
    expect(store.writes).toEqual([{ group: 'acme', version: 1 }]);
    expect(store.values.has('acme')).toBe(true);
  });

  it('publishes the newest version when a change lands mid-write', async () => {
    const { topology, store } = fixture();
    let releaseFirst!: () => void;
    const original = store.publisher.write;
    store.publisher.write = async (snapshot, encoded) => {
      if (snapshot.version === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      await original(snapshot, encoded);
    };

    const first = topology.update('acme', () => ({
      members: [active('acme-0')],
    }));
    await settle();
    const second = topology.update('acme', ({ members }) => ({
      members: [...members, active('acme-1')],
    }));
    await settle();
    releaseFirst();

    await Promise.all([first, second]);
    expect(store.writes.map(({ version }) => version)).toEqual([1, 2]);
  });

  it('deletes explicitly and keeps versions increasing across a recreate', async () => {
    const { topology, store, client, members } = fixture();
    await topology.update('acme', () => ({
      members: [active('acme-0')],
      states: { limits: { max: 1 } },
    }));
    await settle();

    expect(await topology.delete('acme')).toEqual({ published: true });
    expect(store.deletes).toEqual([{ group: 'acme', version: 2 }]);
    expect(topology.snapshot('acme')).toBeUndefined();
    await expect(client.get('acme')).rejects.toBeInstanceOf(
      TopologyUnavailableError
    );

    const recreated = await topology.update('acme', () => ({
      members: [active('acme-0')],
      states: { limits: { max: 2 } },
    }));
    await settle();
    expect(recreated.snapshot.version).toBe(3);
    const versions = (members.applied.get('acme-0') ?? []).map(
      ({ version }) => version
    );
    expect(versions).toHaveLength(2);
    expect(versions[1]).toBeGreaterThan(versions[0]!);
  });

  it('pushes the latest value to each member in the channel role', async () => {
    const { topology, members } = fixture();
    await topology.update('acme', () => ({
      members: [active('acme-0'), { id: 'acme-1', state: 'draining' }],
      states: { limits: { max: 1 }, config: 'v1' },
    }));
    await settle();

    expect(members.values('acme-0')).toEqual([{ max: 1 }]);
    expect(members.values('acme-1')).toEqual([]);
    expect(members.values('acme-1', 'config')).toEqual(['v1']);

    await topology.update('acme', () => ({ states: { limits: { max: 1 } } }));
    await settle();
    expect(members.values('acme-0')).toHaveLength(1);

    await topology.update('acme', ({ members: current }) => ({
      members: [...current, active('acme-2')],
    }));
    await settle();
    expect(members.values('acme-2')).toEqual([{ max: 1 }]);
    expect(members.values('acme-2', 'config')).toEqual(['v1']);
  });

  it('retries a failing member without holding back the others', async () => {
    const { topology, members, events } = fixture();
    members.failing.add('acme-1');
    await topology.update('acme', () => ({
      members: [active('acme-0'), active('acme-1')],
      states: { limits: { max: 1 } },
    }));
    await settle();
    expect(members.values('acme-0')).toEqual([{ max: 1 }]);
    expect(
      events.some(
        (event) =>
          event.channel === 'durability.topology.limits' &&
          event.id === JSON.stringify(['acme', 'acme-1']) &&
          event.type === 'attempt_settled' &&
          event.outcome === 'retry_scheduled'
      )
    ).toBe(true);

    await topology.update('acme', () => ({ states: { limits: { max: 2 } } }));
    await settle();
    members.failing.delete('acme-1');
    vi.advanceTimersByTime(1_000);
    await topology.alarm();
    await settle();

    expect(members.values('acme-0')).toEqual([{ max: 1 }, { max: 2 }]);
    expect(members.values('acme-1')).toEqual([{ max: 2 }]);
  });

  it('cancels pending syncs for members that leave the role', async () => {
    const { topology, members } = fixture();
    members.failing.add('acme-1');
    await topology.update('acme', () => ({
      members: [active('acme-0'), active('acme-1')],
      states: { limits: { max: 1 } },
    }));
    await settle();

    await topology.update('acme', ({ members: current }) => ({
      members: current.map((member) =>
        member.id === 'acme-1' ? { ...member, state: 'draining' } : member
      ),
    }));
    members.failing.delete('acme-1');
    vi.advanceTimersByTime(1_000);
    await topology.alarm();
    await settle();

    expect(members.values('acme-1')).toEqual([]);
  });

  it('does not let an updater that mutates current hide or fake a change', async () => {
    const { topology } = fixture();
    await topology.update('acme', () => ({ members: [active('acme-0')] }));

    const result = await topology.update('acme', ({ members }) => {
      (members[0] as { state: string }).state = 'draining';
      return {};
    });

    expect(result.snapshot.version).toBe(1);
    expect(result.snapshot.members[0]?.state).toBe('active');
    expect(topology.snapshot('acme')?.members[0]?.state).toBe('active');
  });

  it('republishes the latest snapshot when a timed-out write lands late', async () => {
    const store = new Store();
    const original = store.publisher.write;
    let landLate!: () => void;
    store.publisher.write = async (snapshot, encoded) => {
      if (snapshot.version === 1 && landLate === undefined) {
        await new Promise<void>((resolve) => {
          landLate = resolve;
        });
      }
      await original(snapshot, encoded);
      // The abandoned v1 write lands after v2's, before v2 is acknowledged.
      if (snapshot.version === 2 && store.writes.length === 1) {
        landLate();
        for (let tick = 0; tick < 20; tick++) {
          // eslint-disable-next-line no-await-in-loop
          await Promise.resolve();
        }
      }
    };
    const slow = new DurabilityTopology<undefined, States>(
      slowPublishConfig(store)
    );

    const first = slow.update('acme', () => ({ members: [active('acme-0')] }));
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).published).toBe(false);

    const second = await slow.update('acme', ({ members }) => ({
      members: [...members, active('acme-1')],
    }));
    // The late v1 landed mid-publish, so v2 was restaged rather than acknowledged.
    expect(second.published).toBe(false);
    await settle();
    expect(decodeSnapshot(store.values.get('acme')!).version).toBe(2);
    expect(store.writes[store.writes.length - 1]?.version).toBe(2);
  });

  it("publishes while a delivery holds the scheduler's only permit", async () => {
    const store = new Store();
    let release!: () => void;
    let blocked = false;
    const topology = new DurabilityTopology<undefined, States>({
      context: {
        storage: new FakeStorage() as unknown as DurableObjectStorage,
        id: coordinatorId,
      } as never,
      alarmConcurrency: 1,
      publish: store.publisher,
      states: {
        limits: {
          deliver: async () => {
            if (!blocked) {
              blocked = true;
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            }
          },
        },
        config: { deliver: async () => undefined },
      },
    });

    await topology.update('acme', () => ({
      members: [active('acme-0')],
      states: { limits: { max: 1 } },
    }));
    await settle();
    expect(blocked).toBe(true);

    const grown = await topology.update('acme', ({ members }) => ({
      members: [...members, active('acme-1')],
    }));
    expect(grown.published).toBe(true);
    expect(store.writes.map(({ version }) => version)).toEqual([1, 2]);
    release();
    await settle();
  });

  it('waits out a write abandoned before an eviction before acknowledging a newer one', async () => {
    const storage = new FakeStorage();
    const store = new Store();
    let hang = true;
    const write = store.publisher.write;
    const config = {
      context: {
        storage: storage as unknown as DurableObjectStorage,
        id: coordinatorId,
      } as never,
      retries: { delay: () => 60_000 },
      publish: {
        ...store.publisher,
        attemptTimeoutMs: 100,
        write: async (
          snapshot: { group: string; version: number },
          encoded: string
        ) => {
          if (hang) {
            await new Promise(() => undefined);
          }
          await write(snapshot, encoded);
        },
      },
    };

    const evicted = new DurabilityTopology<undefined, States>(config);
    const first = evicted.update('acme', () => ({
      members: [active('acme-0')],
    }));
    await vi.advanceTimersByTimeAsync(100);
    const v1 = await first;
    expect(v1.published).toBe(false);

    // A new instance over the same storage: nothing in memory knows v1's write is outstanding.
    hang = false;
    const revived = new DurabilityTopology<undefined, States>(config);
    const v2 = await revived.update('acme', ({ members }) => ({
      members: [...members, active('acme-1')],
    }));
    expect(v2.published).toBe(false);
    expect(decodeSnapshot(store.values.get('acme')!).version).toBe(2);

    // The abandoned v1 write lands after all, over v2.
    store.values.set('acme', encodeSnapshot(v1.snapshot));
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
    await revived.alarm();
    await settle();

    expect(decodeSnapshot(store.values.get('acme')!).version).toBe(2);
    expect(await revived.update('acme', () => ({}))).toMatchObject({
      published: true,
    });
  });

  it('works without a publisher', async () => {
    const { config } = fixture();
    const { publish: _publish, ...withoutPublisher } = config;
    const topology = new DurabilityTopology<undefined, States>({
      ...withoutPublisher,
      context: {
        storage: new FakeStorage() as unknown as DurableObjectStorage,
        id: coordinatorId,
      } as never,
    });
    const result = await topology.update('acme', () => ({
      members: [active('acme-0')],
    }));
    expect(result.published).toBe(true);
    expect(await topology.delete('acme')).toEqual({ published: true });
  });
});
