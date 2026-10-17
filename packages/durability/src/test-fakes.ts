import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export class NodeSqlStorage {
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
      return {
        rowsRead: 0,
        rowsWritten: 0,
        toArray: () => [],
      } as unknown as SqlStorageCursor<T>;
    }

    const statement = this.database.prepare(query);
    const rows = statement.all(
      ...(bindings as SQLInputValue[])
    ) as unknown as T[];

    return {
      rowsRead: rows.length,
      rowsWritten: 0,
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) {
          throw new Error(`Expected exactly one row, got ${rows.length}`);
        }
        return rows[0];
      },
    } as unknown as SqlStorageCursor<T>;
  }
}

/** A hibernatable WebSocket stand-in that records sent frames and its attachment. */
export class FakeWebSocket {
  readyState = 1;
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  private attachment: unknown = null;

  send(message: string): void {
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
    storage: storage as unknown as DurableObjectStorage,
    sockets,
    acceptWebSocket(ws: WebSocket) {
      sockets.push(ws as unknown as FakeWebSocket);
    },
    getWebSockets() {
      return sockets as unknown as WebSocket[];
    },
    setWebSocketAutoResponse() {},
  };
};

export class FakeStorage {
  private readonly database = new NodeSqlStorage();
  readonly sql = this.database as unknown as SqlStorage;
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
          const value = await closure(
            this as unknown as DurableObjectTransaction
          );
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
}

export const contextFor = (storage: FakeStorage) => ({
  storage: storage as unknown as DurableObjectStorage,
});
