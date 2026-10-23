import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DurableCall } from './index';
import { contextFor, FakeStorage } from './test-fakes';

const traceEntrySchema = z.looseObject({
  event: z.string(),
  seq: z.number(),
  method: z.string().optional(),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

// `devMode` is read once at module load, so each case imports a fresh graph.
const loadDurability = async (dev: boolean | undefined) => {
  if (dev !== undefined) {
    vi.stubGlobal('__DURABILITY_DEV__', dev);
  }
  vi.resetModules();
  const { Durability } = await import('./index');
  return Durability;
};

const runOperation = async (dev: boolean | undefined) => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  const Durability = await loadDurability(dev);
  const durability = new Durability({
    context: contextFor(new FakeStorage()),
    handlers: {
      greet: async ({ payload }: DurableCall<{ name: string }>) =>
        `hello ${payload.name}`,
    },
  });

  await durability.greet({ id: 'greet-1', payload: { name: 'Ada' } });
  await vi.waitFor(async () => {
    expect(await durability.greet.getResult('greet-1')).toEqual({
      status: 'completed',
      result: 'hello Ada',
    });
  });

  return debug.mock.calls.map(
    ([entry]) =>
      entry as { event: string; seq: number } & Record<string, unknown>
  );
};

describe('dev mode', () => {
  it.skipIf(process.env['DURABILITY_DEV'] === '1')(
    'logs nothing unless the build defines __DURABILITY_DEV__',
    async () => {
      expect(await runOperation(undefined)).toEqual([]);
      expect(await runOperation(false)).toEqual([]);
    }
  );

  it('logs API calls, storage access, and lifecycle events in order', async () => {
    const entries = await runOperation(true);
    const events = entries.map(({ event }) => event);

    expect(entries.map(({ seq }) => seq)).toEqual(
      entries.map((_, index) => index + 1)
    );
    expect(entries[0]).toMatchObject({
      event: 'durability.dev.sql',
      query:
        'SELECT name, down FROM durability_migrations WHERE capability = ?',
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: 'durability.dev.sql',
        query: expect.stringContaining('CREATE TABLE IF NOT EXISTS'),
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: 'durability.dev.call',
        method: 'Durability.greet',
        args: [{ id: 'greet-1', payload: { name: 'Ada' } }],
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: 'durability.dev.sql',
        query: expect.stringContaining('INSERT INTO durability_calls'),
      })
    );
    const lifecycle = entries.find(
      (entry) =>
        entry.event === 'durability.dev.lifecycle' &&
        entry['outcome'] === 'completed'
    );
    expect(lifecycle).toMatchObject({
      type: 'attempt_settled',
      outcome: 'completed',
    });
    // Results stay out of the default lifecycle event; dev mode still surfaces
    // them through the handler return trace below.
    expect(lifecycle).not.toHaveProperty('result');
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: 'durability.dev.call.return',
        result: { status: 'completed', result: 'hello Ada' },
      })
    );
    expect(events.indexOf('durability.dev.lifecycle')).toBeGreaterThan(
      events.indexOf('durability.dev.call')
    );
  });

  it('logs a rejected memoize call with its owner, key, and attempt', async () => {
    const debug = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);
    const Durability = await loadDurability(true);
    const durability = new Durability({
      context: contextFor(new FakeStorage()),
      retries: { maxAttempts: 1 },
      handlers: {
        work: async ({ memoize }: DurableCall<null>) =>
          memoize('fetch', () => {
            throw new Error('upstream down');
          }),
      },
    });

    await durability.work({ id: 'step-1', payload: null });
    await vi.waitFor(async () => {
      expect(await durability.work.getResult('step-1')).toMatchObject({
        status: 'failed',
      });
    });

    const entries = traceEntrySchema
      .array()
      .parse(debug.mock.calls.map(([entry]) => entry));
    const call = entries.find(
      (entry) =>
        entry.event === 'durability.dev.call' && entry.method === 'memoize'
    );
    expect(call).toMatchObject({
      owner: 'durability_calls',
      key: 'step-1',
      attempt: 1,
      memoKey: 'fetch',
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: 'durability.dev.call.throw',
        call: call?.seq,
        error: expect.objectContaining({ message: 'upstream down' }),
      })
    );
  });
});
