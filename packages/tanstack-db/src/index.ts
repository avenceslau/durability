import type {
  BaseCollectionConfig,
  ChangeMessageOrDeleteKeyMessage,
  CollectionConfig,
  DeleteMutationFnParams,
  InsertMutationFnParams,
  UpdateMutationFnParams,
} from '@tanstack/db';
import type {
  AnySocketShape,
  OutboundOf,
  SocketConnection,
  SocketOutboundPayload,
} from 'durability/client';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/** A row change to apply to the collection; inserts are applied as upserts. */
export type SocketChange<
  Row extends object,
  Key extends string | number,
> = ChangeMessageOrDeleteKeyMessage<Row, Key>;

/** Utilities available on `collection.utils` and inside mutation handlers. */
export type SocketCollectionUtils<
  Row extends object,
  Key extends string | number,
> = {
  /**
   * Applies authoritative changes outside the event stream, for example a row
   * returned by an RPC call. Safe to call from mutation handlers.
   */
  write: (changes: SocketChange<Row, Key> | SocketChange<Row, Key>[]) => void;
};

type Rpc<Socket extends AnySocketShape> = SocketConnection<Socket>['rpc'];

type MutationContext<Socket extends AnySocketShape> = {
  /** The connection's typed RPC methods. */
  rpc: Rpc<Socket>;
  /**
   * Resolves once every key in the transaction has been written by a sync
   * commit since the mutation began, or after `timeoutMs` (default 30s).
   * Await it before returning when the confirming event arrives after the
   * RPC response, such as a durable operation that completes later.
   */
  awaitSynced: (options?: { timeoutMs?: number }) => Promise<void>;
};

type MutationHandler<Params, Socket extends AnySocketShape> = (
  params: Params & MutationContext<Socket>
) => Promise<void>;

export type SocketCollectionConfig<
  Socket extends AnySocketShape,
  Row extends object,
  Key extends string | number,
  Schema extends StandardSchemaV1 = never,
> = Omit<
  BaseCollectionConfig<Row, Key, Schema, SocketCollectionUtils<Row, Key>>,
  'id' | 'utils' | 'onInsert' | 'onUpdate' | 'onDelete'
> & {
  id: string;
  connection: SocketConnection<Socket>;
  /** Loads the full row set; runs on connect and whenever missed events cannot be replayed. */
  snapshot: (rpc: Rpc<Socket>) => Promise<Row[]>;
  /** Maps outbound socket events to row changes. Return nothing to ignore an event. */
  on?: {
    [Event in keyof OutboundOf<Socket>]?: (
      payload: SocketOutboundPayload<OutboundOf<Socket>[Event]>
    ) => SocketChange<Row, Key> | SocketChange<Row, Key>[] | void;
  };
  onInsert?: MutationHandler<
    InsertMutationFnParams<Row, Key, SocketCollectionUtils<Row, Key>>,
    Socket
  >;
  onUpdate?: MutationHandler<
    UpdateMutationFnParams<Row, Key, SocketCollectionUtils<Row, Key>>,
    Socket
  >;
  onDelete?: MutationHandler<
    DeleteMutationFnParams<Row, Key, SocketCollectionUtils<Row, Key>>,
    Socket
  >;
};

type SyncWriter<Row extends object, Key extends string | number> = (
  changes: SocketChange<Row, Key>[]
) => void;

/**
 * Builds TanStack DB collection options backed by a `DurabilitySocket`
 * connection: a snapshot RPC seeds the collection, outbound events keep it
 * current, and optimistic mutations are forwarded to the connection's RPC.
 *
 * The snapshot runs when the connection reports `resync` for one of the
 * mapped events: on first subscription and after an unreplayable gap. Events
 * received while a snapshot is in flight are dropped: the socket delivers
 * frames in order and the Durable Object runs one message at a time, so
 * anything that arrived before the snapshot response is already in it.
 *
 * @example
 * ```ts
 * const todos = createCollection(
 *   socketCollectionOptions<TodoList['socket'], Todo, string>({
 *     id: 'todos',
 *     connection: client.connect('personal'),
 *     getKey: (todo) => todo.id,
 *     snapshot: (rpc) => rpc.list(),
 *     on: {
 *       created: (todo) => ({ type: 'insert', value: todo }),
 *       updated: (todo) => ({ type: 'update', value: todo }),
 *       removed: (id) => ({ type: 'delete', key: id }),
 *     },
 *     onInsert: async ({ transaction, rpc }) => {
 *       for (const { modified } of transaction.mutations) {
 *         await rpc.create(modified);
 *       }
 *     },
 *   })
 * );
 * ```
 */
export const socketCollectionOptions = <
  Socket extends AnySocketShape,
  Row extends object,
  Key extends string | number,
  Schema extends StandardSchemaV1 = never,
>(
  config: SocketCollectionConfig<Socket, Row, Key, Schema>
): CollectionConfig<Row, Key, Schema, SocketCollectionUtils<Row, Key>> & {
  id: string;
  utils: SocketCollectionUtils<Row, Key>;
} => {
  const {
    connection,
    getKey,
    snapshot: loadSnapshot,
    on,
    onInsert,
    onUpdate,
    onDelete,
    ...base
  } = config;
  let writer: SyncWriter<Row, Key> | undefined;
  const writeCounts = new Map<Key, number>();
  const waiters = new Set<() => void>();

  const keyOf = (change: SocketChange<Row, Key>): Key =>
    change.type === 'delete' && 'key' in change && change.key !== undefined
      ? change.key
      : getKey((change as { value: Row }).value);

  const recordWrites = (changes: SocketChange<Row, Key>[]) => {
    for (const change of changes) {
      const key = keyOf(change);
      writeCounts.set(key, (writeCounts.get(key) ?? 0) + 1);
    }
    for (const waiter of waiters) {
      waiter();
    }
  };

  const utils: SocketCollectionUtils<Row, Key> = {
    write: (changes) => {
      if (!writer) {
        throw new Error(`Collection "${base.id}" has not started syncing`);
      }
      writer(Array.isArray(changes) ? changes : [changes]);
    },
  };

  const awaitSyncedFrom =
    (keys: Key[]) =>
    ({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}) => {
      const since = new Map(
        keys.map((key) => [key, writeCounts.get(key) ?? 0])
      );
      const synced = () =>
        keys.every(
          (key) => (writeCounts.get(key) ?? 0) > (since.get(key) ?? 0)
        );
      return new Promise<void>((resolve) => {
        if (synced()) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          waiters.delete(check);
          resolve();
        }, timeoutMs);
        const check = () => {
          if (!synced()) {
            return;
          }
          clearTimeout(timer);
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
      });
    };

  const withContext =
    <Params extends { transaction: { mutations: { key: Key }[] } }>(
      handler: MutationHandler<Params, Socket>
    ) =>
    (params: Params) => {
      const keys = params.transaction.mutations.map((mutation) => mutation.key);
      const awaitSynced = awaitSyncedFrom(keys);
      return handler({ ...params, rpc: connection.rpc, awaitSynced });
    };

  return {
    ...base,
    getKey,
    utils,
    ...(onInsert ? { onInsert: withContext(onInsert) } : {}),
    ...(onUpdate ? { onUpdate: withContext(onUpdate) } : {}),
    ...(onDelete ? { onDelete: withContext(onDelete) } : {}),
    sync: {
      rowUpdateMode: 'full',
      sync: ({ begin, write, commit, truncate, markError }) => {
        let generation = 0;
        let snapshotting = true;

        const apply: SyncWriter<Row, Key> = (changes) => {
          if (changes.length === 0) {
            return;
          }
          begin();
          for (const change of changes) {
            // Event inserts may repeat a row already present; `full` updates upsert.
            write(
              change.type === 'insert' ? { ...change, type: 'update' } : change
            );
          }
          commit();
          recordWrites(changes);
        };
        writer = apply;

        const snapshot = async () => {
          const current = ++generation;
          snapshotting = true;
          try {
            const rows = await loadSnapshot(connection.rpc);
            if (current !== generation) {
              return;
            }
            begin();
            truncate();
            for (const value of rows) {
              write({ type: 'insert', value });
            }
            commit();
            recordWrites(rows.map((value) => ({ type: 'insert', value })));
          } catch (error) {
            if (current === generation) {
              markError(error);
            }
          } finally {
            if (current === generation) {
              snapshotting = false;
            }
          }
        };

        const unsubscribers: (() => void)[] = [];
        const names = new Set(Object.keys(on ?? {}));
        // Fires once our subscriptions are acknowledged without history (first
        // subscribe, or an unreplayable gap), so the snapshot is never issued
        // ahead of the subscription it must line up with.
        unsubscribers.push(
          connection.on.resync((info) => {
            if (info.names.some((name) => names.has(name))) {
              void snapshot();
            }
          })
        );

        for (const [event, map] of Object.entries(on ?? {})) {
          if (!map) {
            continue;
          }
          const subscribe = connection.on[
            event as keyof OutboundOf<Socket>
          ] as (handler: (payload: unknown) => void) => () => void;
          unsubscribers.push(
            subscribe((payload) => {
              if (snapshotting) {
                return;
              }
              const changes = (map as (payload: unknown) => unknown)(payload) as
                | SocketChange<Row, Key>
                | SocketChange<Row, Key>[]
                | void;
              if (!changes) {
                return;
              }
              apply(Array.isArray(changes) ? changes : [changes]);
            })
          );
        }

        return () => {
          generation += 1;
          writer = undefined;
          for (const unsubscribe of unsubscribers) {
            unsubscribe();
          }
        };
      },
    },
  };
};
