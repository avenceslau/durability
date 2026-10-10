import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export class NodeSqlStorage {
  private readonly database = new DatabaseSync(':memory:');

  transaction<T>(closure: () => T): T {
    this.database.exec('BEGIN');
    try {
      const result = closure();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async transactionAsync<T>(closure: () => Promise<T>): Promise<T> {
    this.database.exec('BEGIN');
    try {
      const value = await closure();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
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
    } as unknown as SqlStorageCursor<T>;
  }
}

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

export class FakeKvStorage {
  private entries = new Map<string, unknown>();
  private transactionTail = Promise.resolve();
  alarmAt: number | null = null;
  transactionCommitBarrier?: Promise<void>;

  async get<T>(key: string): Promise<T | undefined>;
  async get<T>(keys: string[]): Promise<Map<string, T>>;
  async get<T>(
    keyOrKeys: string | string[]
  ): Promise<T | Map<string, T> | undefined> {
    if (typeof keyOrKeys === 'string') {
      return this.entries.get(keyOrKeys) as T | undefined;
    }
    if (keyOrKeys.length > 128) {
      throw new RangeError('get batch exceeds Durable Object KV limit');
    }
    return new Map(
      keyOrKeys.flatMap((key) =>
        this.entries.has(key) ? [[key, this.entries.get(key) as T]] : []
      )
    );
  }

  async list<T>(
    options: DurableObjectListOptions = {}
  ): Promise<Map<string, T>> {
    let keys = [...this.entries.keys()].sort();
    if (options.prefix !== undefined) {
      keys = keys.filter((key) => key.startsWith(options.prefix ?? ''));
    }
    if (options.start !== undefined) {
      keys = keys.filter((key) => key >= (options.start ?? ''));
    }
    if (options.startAfter !== undefined) {
      keys = keys.filter((key) => key > (options.startAfter ?? ''));
    }
    if (options.end !== undefined) {
      keys = keys.filter((key) => key < (options.end ?? ''));
    }
    if (options.reverse) {
      keys.reverse();
    }
    if (options.limit !== undefined) {
      keys = keys.slice(0, options.limit);
    }
    return new Map(keys.map((key) => [key, this.entries.get(key) as T]));
  }

  async put<T>(key: string, value: T): Promise<void>;
  async put<T>(entries: Record<string, T>): Promise<void>;
  async put<T>(keyOrEntries: string | Record<string, T>, value?: T) {
    const entries =
      typeof keyOrEntries === 'string'
        ? { [keyOrEntries]: value }
        : keyOrEntries;
    for (const [key, entry] of Object.entries(entries)) {
      this.entries.set(key, structuredClone(entry));
    }
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (typeof keyOrKeys === 'string') {
      return this.entries.delete(keyOrKeys);
    }
    if (keyOrKeys.length > 128) {
      throw new RangeError('delete batch exceeds Durable Object KV limit');
    }
    return keyOrKeys.reduce(
      (count, key) => count + Number(this.entries.delete(key)),
      0
    );
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(timestamp: number | Date): Promise<void> {
    this.alarmAt = timestamp instanceof Date ? timestamp.getTime() : timestamp;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  async transaction<T>(
    closure: (transaction: DurableObjectTransaction) => Promise<T>
  ): Promise<T> {
    const result = this.transactionTail.then(async () => {
      const entries = structuredClone(this.entries);
      const alarmAt = this.alarmAt;
      try {
        const value = await closure(
          this as unknown as DurableObjectTransaction
        );
        await this.transactionCommitBarrier;
        return value;
      } catch (error) {
        this.entries = entries;
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

export const contextForKv = (storage: FakeKvStorage) => ({
  storage: storage as unknown as DurableObjectStorage,
});
