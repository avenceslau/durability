import { describe, expect, it } from 'vitest';
import { Durability, DurabilityAlarms } from './index';
import { contextFor, FakeStorage } from './test-fakes';

const tableNames = (storage: FakeStorage): string[] =>
  storage.sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .toArray()
    .map(({ name }) => name);

const seedPendingCall = (storage: FakeStorage): void => {
  storage.sql.exec(
    `INSERT INTO durability_calls
       (id, operation, payload, status, attempt, next_attempt_at)
     VALUES ('job', 'work', '{"kind":"value","value":null}', 'pending', 0, 0)`
  );
};

describe('destructive migration guards', () => {
  it('refuses a rollback that drops data without an acknowledgement', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    await Durability.migrate(context);

    await expect(Durability.migrate(context, null)).rejects.toThrow(
      /allowDataLoss/
    );
    expect(tableNames(storage)).toContain('durability_calls');
  });

  it('refuses a full reset while operations are pending', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    await Durability.migrate(context);
    seedPendingCall(storage);
    storage.alarmAt = Date.now() + 10_000;

    await expect(
      Durability.migrate(context, null, { allowDataLoss: true })
    ).rejects.toThrow(/pending/i);

    expect(tableNames(storage)).toContain('durability_calls');
    expect(
      storage.sql
        .exec('SELECT COUNT(*) AS count FROM durability_calls')
        .toArray()[0]?.['count']
    ).toBe(1);
    expect(storage.alarmAt).not.toBeNull();
  });

  it('forces a reset and clears the stale physical alarm', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    await Durability.migrate(context);
    seedPendingCall(storage);
    storage.alarmAt = Date.now() + 10_000;

    const result = await Durability.migrate(context, null, {
      allowDataLoss: true,
      force: true,
    });

    expect(result.reset).toBe(true);
    expect(tableNames(storage)).toEqual([]);
    expect(storage.alarmAt).toBeNull();
  });

  it('resets a drained schema and clears the physical alarm', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    await Durability.migrate(context);
    storage.alarmAt = Date.now() + 10_000;

    const result = await Durability.migrate(context, null, {
      allowDataLoss: true,
    });

    expect(result.reset).toBe(true);
    expect(tableNames(storage)).toEqual([]);
    expect(storage.alarmAt).toBeNull();
  });

  it('refuses to drop named alarms while work is pending', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    await DurabilityAlarms.migrate(context);
    storage.sql.exec(
      `INSERT INTO durability_alarms
         (name, generation_id, status, scheduled_at, next_attempt_at, attempt)
       VALUES ('cleanup', 'gen', 'pending', 0, 0, 0)`
    );

    await expect(
      DurabilityAlarms.migrate(context, null, { allowDataLoss: true })
    ).rejects.toThrow(/pending/i);
    expect(tableNames(storage)).toContain('durability_alarms');
  });
});
