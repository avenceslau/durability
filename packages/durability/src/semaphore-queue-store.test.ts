import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurabilitySemaphoreQueue } from './semaphore-queue';
import { QueueStore } from './semaphore-queue-store';
import { contextFor, FakeStorage } from './test-fakes';

afterEach(() => {
  vi.restoreAllMocks();
});

const fixture = () => {
  const storage = new FakeStorage();
  DurabilitySemaphoreQueue.migrate(contextFor(storage));
  return { storage, store: new QueueStore(storage.sql, 'default') };
};

describe('queue storage', () => {
  it('does not rewrite an unchanged key but still persists count and pacing changes', () => {
    const { storage, store } = fixture();
    const key = {
      key: 'account',
      next_request_at: 20,
      queued: 1,
    };
    store.upsertKey(key);
    expect(storage.sql.exec('SELECT changes() AS changed').one()).toEqual({
      changed: 1,
    });

    store.upsertKey(key);
    expect(storage.sql.exec('SELECT changes() AS changed').one()).toEqual({
      changed: 0,
    });
    expect(store.getKey(key.key)).toEqual(key);

    store.upsertKey({ ...key, queued: 2 });
    expect(storage.sql.exec('SELECT changes() AS changed').one()).toEqual({
      changed: 1,
    });
    expect(store.getKey(key.key)).toEqual({ ...key, queued: 2 });

    const rescheduled = {
      ...key,
      queued: 2,
      next_request_at: 25,
    };
    store.upsertKey(rescheduled);
    expect(storage.sql.exec('SELECT changes() AS changed').one()).toEqual({
      changed: 1,
    });
    expect(store.getKey(key.key)).toEqual(rescheduled);
  });
  it('uses one statement and returns undefined when every source is empty', () => {
    const { storage, store } = fixture();
    const exec = vi.spyOn(storage.sql, 'exec');

    expect(store.nextPendingAt(false)).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockClear();
    expect(store.nextPendingAt(true)).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('includes zero deadlines and ignores keys without queued work', () => {
    const { store } = fixture();
    store.upsertKey({
      key: 'empty',
      next_request_at: 0,
      queued: 0,
    });
    store.upsertKey({
      key: 'later',
      next_request_at: 20,
      queued: 1,
    });

    expect(store.nextPendingAt(false)).toBe(20);
    store.upsertKey({
      key: 'due',
      next_request_at: 0,
      queued: 1,
    });
    expect(store.nextPendingAt(false)).toBe(0);
    store.removeKey('due');
    expect(store.nextPendingAt(false)).toBe(20);
  });

  it('only includes notified items when finished checks are enabled', () => {
    const { storage, store } = fixture();
    storage.sql.exec(`
      INSERT INTO durability_semaphore_queue_items
        (id, key, grp, payload, status, notified, created_at, next_attempt_at)
      VALUES
        ('queued', 'account', '', 'null', 'queued', 0, 0, 0),
        ('claiming', 'account', '', 'null', 'claiming', 0, 0, 1),
        ('notified', 'account', '', 'null', 'admitted', 1, 0, 10),
        ('unnotified', 'account', '', 'null', 'admitted', 0, 0, 40);
    `);

    expect(store.nextPendingAt(false)).toBe(40);
    expect(store.nextPendingAt(true)).toBe(10);
    store.removeItem('unnotified');
    expect(store.nextPendingAt(false)).toBeUndefined();
    expect(store.nextPendingAt(true)).toBe(10);
  });

  it('preserves renewal and expiry rules while taking the minimum across all sources', () => {
    const { storage, store } = fixture();
    store.upsertKey({
      key: 'account',
      next_request_at: 80,
      queued: 1,
    });
    storage.sql.exec(`
      INSERT INTO durability_semaphore_queue_items
        (id, key, grp, payload, status, created_at, next_attempt_at)
      VALUES ('item', 'account', '', 'null', 'admitted', 0, 60);
      INSERT INTO durability_semaphore_queue_leases
        (lease_id, key, grp, permits, drawn, released, created_at,
         expires_at, renew_at, renew_ms, confirmed)
      VALUES
        ('active', 'account', '', 2, 2, 1, 0, 100, 30, 50, 0),
        ('idle', 'account', '', 2, 2, 2, 0, 50, 5, 50, 0),
        ('expired', 'account', '', 2, 2, 2, 0, 5, 50, 50, 0),
        ('settled', 'account', '', 2, 2, 2, 0, 1, 1, 50, 1);
    `);
    const exec = vi.spyOn(storage.sql, 'exec');

    expect(store.nextPendingAt(false)).toBe(30);
    expect(exec).toHaveBeenCalledTimes(1);

    storage.sql.exec(
      `UPDATE durability_semaphore_queue_leases
       SET confirmed = 1 WHERE lease_id = 'active'`
    );
    expect(store.nextPendingAt(false)).toBe(50);
    storage.sql.exec(
      'UPDATE durability_semaphore_queue_leases SET confirmed = 1'
    );
    expect(store.nextPendingAt(false)).toBe(60);
    store.removeItem('item');
    expect(store.nextPendingAt(false)).toBe(80);
    store.removeKey('account');
    expect(store.nextPendingAt(false)).toBeUndefined();
  });

  it('scopes items, grants, keys, leases, and due times to one channel', () => {
    const { storage, store } = fixture();
    const side = new QueueStore(storage.sql, 'side');
    for (const [target, at] of [
      [store, 50],
      [side, 10],
    ] as const) {
      target.insertItem({
        id: 'same',
        key: 'account',
        grp: '',
        payload: 'null',
        status: 'queued',
        grant_id: null,
        lease_id: null,
        created_at: at,
        admitted_at: null,
        notified: 0,
        attempt: 0,
        next_attempt_at: at,
      });
      target.insertGrant({
        grant_id: 'g',
        key: 'account',
        grp: '',
        permits: at,
        claimed: 0,
        confirmed: 0,
        admitted: 0,
        released: 0,
        created_at: at,
      });
      target.upsertKey({
        key: 'account',
        next_request_at: at,
        queued: 1,
      });
    }

    expect(store.getItem('same')?.created_at).toBe(50);
    expect(side.getItem('same')?.created_at).toBe(10);
    expect(store.getGrant('g')?.permits).toBe(50);
    expect(side.getGrant('g')?.permits).toBe(10);
    expect(store.nextPendingAt(false)).toBe(50);
    expect(side.nextPendingAt(false)).toBe(10);
    expect(store.listDueKeys(20)).toEqual([]);
    expect(side.listDueKeys(20)).toHaveLength(1);

    side.removeItem('same');
    side.removeGrant('g');
    side.removeKey('account');
    expect(store.countItems()).toEqual({
      queued: 1,
      claiming: 0,
      admitted: 0,
    });
    expect(side.countItems()).toEqual({
      queued: 0,
      claiming: 0,
      admitted: 0,
    });
    expect(store.getGrant('g')).toBeDefined();
    expect(store.getKey('account')).toBeDefined();
    expect(side.nextPendingAt(false)).toBeUndefined();
  });
});
