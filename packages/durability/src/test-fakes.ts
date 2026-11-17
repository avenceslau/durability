import { DatabaseSync } from 'node:sqlite';
import { isString } from './predicates.js';

function unsupported(member: string): never {
  throw new Error(`The test fake does not implement ${member}`);
}

const cursorOf = <T extends Record<string, SqlStorageValue>>(
  rows: T[]
): SqlStorageCursor<T> => {
  const iterator = rows.values();

  return {
    next: () => {
      const result = iterator.next();

      return result.done ? { done: true } : { value: result.value };
    },
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) {
        throw new Error(`Expected exactly one row, got ${rows.length}`);
      }

      return rows[0]!;
    },
    raw: () => unsupported('SqlStorageCursor.raw'),
    get columnNames(): never {
      return unsupported('SqlStorageCursor.columnNames');
    },
    rowsRead: rows.length,
    rowsWritten: 0,
    [Symbol.iterator]: () => iterator,
  };
};

export class NodeSqlStorage implements SqlStorage {
  private readonly database = new DatabaseSync(':memory:');

  private depth = 0;

  // Nested transactions use savepoints, as SQLite-backed Durable Objects do.
  private begin(): string | undefined {
    this.depth += 1;

    if (this.depth === 1) {
      this.database.exec('BEGIN');

      return undefined;
    }

    const savepoint = `nested_${this.depth}`;
    this.database.exec(`SAVEPOINT ${savepoint}`);

    return savepoint;
  }

  private commit(savepoint: string | undefined): void {
    this.depth -= 1;
    this.database.exec(
      savepoint === undefined ? 'COMMIT' : `RELEASE ${savepoint}`
    );
  }

  private rollback(savepoint: string | undefined): void {
    this.depth -= 1;
    this.database.exec(
      savepoint === undefined
        ? 'ROLLBACK'
        : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`
    );
  }

  transaction<T>(closure: () => T): T {
    const savepoint = this.begin();

    try {
      const result = closure();
      this.commit(savepoint);

      return result;
    } catch (error) {
      this.rollback(savepoint);
      throw error;
    }
  }

  async transactionAsync<T>(closure: () => Promise<T>): Promise<T> {
    const savepoint = this.begin();

    try {
      const value = await closure();
      this.commit(savepoint);

      return value;
    } catch (error) {
      this.rollback(savepoint);
      throw error;
    }
  }

  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlStorageCursor<T> {
    const statements = query.split(';').filter((statement) => statement.trim());

    if (bindings.length === 0 && statements.length > 1) {
      this.database.exec(query);

      return cursorOf<T>([]);
    }

    const statement = this.database.prepare(query);

    const values = bindings.map((value) =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : value
    );

    // SAFETY: as with workerd's SqlStorage, the caller names its query's row
    // type; no table has BLOB columns and integers read as numbers.
    return cursorOf(statement.all(...values) as T[]);
  }

  get databaseSize(): never {
    return unsupported('SqlStorage.databaseSize');
  }

  get Cursor(): never {
    return unsupported('SqlStorage.Cursor');
  }

  get Statement(): never {
    return unsupported('SqlStorage.Statement');
  }
}

/** A hibernatable WebSocket stand-in that records sent frames and its attachment. */
export class FakeWebSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState: 0 | 1 | 2 | 3 = 1;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  private attachment: unknown = null;

  get url(): never {
    return unsupported('WebSocket.url');
  }

  get protocol(): never {
    return unsupported('WebSocket.protocol');
  }

  get extensions(): never {
    return unsupported('WebSocket.extensions');
  }

  get bufferedAmount(): never {
    return unsupported('WebSocket.bufferedAmount');
  }

  accept(): never {
    return unsupported('WebSocket.accept');
  }

  send(message: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (!isString(message)) {
      unsupported('binary WebSocket messages');
    }

    this.sent.push(message);
  }

  close(code: number, reason: string): void {
    this.readyState = 3;
    this.closed = { code, reason };
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  frames(): unknown[] {
    return this.sent.map((text) => JSON.parse(text));
  }
}

export const socketContextFor = (storage: FakeStorage) => {
  const sockets: FakeWebSocket[] = [];

  return {
    storage,
    sockets,
    acceptWebSocket(ws: WebSocket) {
      if (!(ws instanceof FakeWebSocket)) {
        unsupported('accepting a WebSocket that is not a FakeWebSocket');
      }

      sockets.push(ws);
    },
    getWebSockets(): WebSocket[] {
      return sockets;
    },
    setWebSocketAutoResponse() {},
  };
};

export class FakeStorage
  implements DurableObjectStorage, DurableObjectTransaction
{
  private readonly database = new NodeSqlStorage();
  readonly sql: SqlStorage = this.database;
  alarmAt: number | null = null;

  transactionSync<T>(closure: () => T): T {
    return this.database.transaction(closure);
  }

  alarmSetupBarrier?: Promise<void>;
  transactionCommitBarrier?: Promise<void>;
  private transactionTail = Promise.resolve();

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(timestamp: number | Date): Promise<void> {
    this.alarmAt = timestamp instanceof Date ? timestamp.getTime() : timestamp;
    await this.alarmSetupBarrier;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  async transaction<T>(
    closure: (transaction: DurableObjectTransaction) => Promise<T>
  ): Promise<T> {
    const result = this.transactionTail.then(async () => {
      const alarmAt = this.alarmAt;

      try {
        return await this.database.transactionAsync(async () => {
          const value = await closure(this);

          await this.transactionCommitBarrier;

          return value;
        });
      } catch (error) {
        this.alarmAt = alarmAt;
        throw error;
      }
    });

    this.transactionTail = result.then(
      () => undefined,
      () => undefined
    );

    return result;
  }

  get(): never {
    return unsupported('DurableObjectStorage.get');
  }

  list(): never {
    return unsupported('DurableObjectStorage.list');
  }

  put(): never {
    return unsupported('DurableObjectStorage.put');
  }

  delete(): never {
    return unsupported('DurableObjectStorage.delete');
  }

  deleteAll(): never {
    return unsupported('DurableObjectStorage.deleteAll');
  }

  sync(): never {
    return unsupported('DurableObjectStorage.sync');
  }

  get kv(): never {
    return unsupported('DurableObjectStorage.kv');
  }

  getCurrentBookmark(): never {
    return unsupported('DurableObjectStorage.getCurrentBookmark');
  }

  getBookmarkForTime(): never {
    return unsupported('DurableObjectStorage.getBookmarkForTime');
  }

  onNextSessionRestoreBookmark(): never {
    return unsupported('DurableObjectStorage.onNextSessionRestoreBookmark');
  }

  rollback(): never {
    return unsupported('DurableObjectTransaction.rollback');
  }
}

/**
 * Each call is a new object instance over the same stored data: the runtime
 * gives a restarted object a new `storage`, and durability keys the object's
 * scheduler by it. Share one context between helpers of one instance.
 */
export const contextFor = (storage: FakeStorage) => ({
  storage: new Proxy(storage, {}),
});

export const waitUntilContext = (
  storage: FakeStorage,
  sink: Promise<unknown>[]
) => ({
  ...contextFor(storage),
  waitUntil(promise: Promise<unknown>) {
    sink.push(promise);
  },
});
