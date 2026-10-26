import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimAttempt } from './storage';
import { FakeStorage } from './test-fakes';

const table = { name: 'attempts', key: 'id' };
const fixture = () => {
  const storage = new FakeStorage();
  storage.sql.exec(`
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL
    );
    INSERT INTO attempts VALUES ('job', 'current', 'pending', 0, 100);
  `);
  return storage;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attempt claims', () => {
  it('persists the attempt and deadline with one statement', () => {
    const storage = fixture();
    const exec = vi.spyOn(storage.sql, 'exec');

    expect(claimAttempt(storage.sql, table, 'job', 'current', 2, 500)).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(
      storage.sql.exec('SELECT attempt, next_attempt_at FROM attempts').one()
    ).toEqual({ attempt: 1, next_attempt_at: 500 });
  });

  it('does not assign the indexed deadline column for ordinary claims', () => {
    const storage = fixture();
    const exec = vi.spyOn(storage.sql, 'exec');

    expect(claimAttempt(storage.sql, table, 'job', 'current', 2)).toBe(1);
    expect(exec.mock.calls[0]?.[0]).not.toContain('next_attempt_at');
    expect(
      storage.sql.exec('SELECT attempt, next_attempt_at FROM attempts').one()
    ).toEqual({ attempt: 1, next_attempt_at: 100 });
  });

  it('accepts a zero deadline and still stops at the attempt limit', () => {
    const storage = fixture();

    expect(claimAttempt(storage.sql, table, 'job', 'current', 1, 0)).toBe(1);
    expect(
      claimAttempt(storage.sql, table, 'job', 'current', 1, 500)
    ).toBeUndefined();
    expect(
      storage.sql.exec('SELECT attempt, next_attempt_at FROM attempts').one()
    ).toEqual({ attempt: 1, next_attempt_at: 0 });
  });

  it('does not change a missing, replaced or settled generation', () => {
    const storage = fixture();

    expect(
      claimAttempt(storage.sql, table, 'missing', 'current', 2, 500)
    ).toBeUndefined();
    expect(
      claimAttempt(storage.sql, table, 'job', 'old', 2, 500)
    ).toBeUndefined();
    storage.sql.exec("UPDATE attempts SET status = 'completed'");
    expect(
      claimAttempt(storage.sql, table, 'job', 'current', 2, 500)
    ).toBeUndefined();
    expect(
      storage.sql.exec('SELECT attempt, next_attempt_at FROM attempts').one()
    ).toEqual({ attempt: 0, next_attempt_at: 100 });
  });

  it('rolls both fields back when the surrounding transaction fails', () => {
    const storage = fixture();

    expect(() =>
      storage.transactionSync(() => {
        expect(claimAttempt(storage.sql, table, 'job', 'current', 2, 500)).toBe(
          1
        );
        throw new Error('rollback');
      })
    ).toThrow('rollback');
    expect(
      storage.sql.exec('SELECT attempt, next_attempt_at FROM attempts').one()
    ).toEqual({ attempt: 0, next_attempt_at: 100 });
  });
});
