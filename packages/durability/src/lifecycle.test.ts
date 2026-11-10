import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Durability, type DurableCall } from './index';
import { contextFor, FakeStorage } from './test-fakes';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('lifecycle hooks', () => {
  it('fans events out to attached hooks with typed completed results', async () => {
    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        work: async ({ payload }: DurableCall<number>) => payload * 2,
      },
      includeResults: true,
    });
    const configured: string[] = [];
    const results: number[] = [];
    const detach = durability.lifecycle((event) => {
      if (event.type === 'attempt_settled' && event.outcome === 'completed') {
        expectTypeOf(event.result).toEqualTypeOf<number | undefined>();
        expectTypeOf(event.operation).toEqualTypeOf<'work'>();
        if (event.result !== undefined) {
          results.push(event.result);
        }
      }
    });
    durability.lifecycle((event) => {
      configured.push(event.type);
    });

    await durability.work({ id: 'first', payload: 21 });
    await vi.waitFor(() => expect(results).toEqual([42]));

    detach();
    await durability.work({ id: 'second', payload: 1 });
    await vi.waitFor(() =>
      expect(
        configured.filter((type) => type === 'attempt_settled')
      ).toHaveLength(2)
    );
    expect(results).toEqual([42]);
  });

  it('reserves "lifecycle" as a handler name', () => {
    expect(
      () =>
        new Durability({
          context: contextFor(new FakeStorage()),
          handlers: { lifecycle: async () => undefined },
        })
    ).toThrow('"lifecycle" is reserved by Durability');
  });
});
