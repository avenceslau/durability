import { describe, expect, it } from 'vitest';
import { coalescer } from '../src/coalesce';

/** A destination whose calls finish only when the test says so. */
const destination = () => {
  const calls: { inputs: number[]; finish: (fail?: Error) => void }[] = [];
  const call = coalescer<number, string>({
    invoke: (_key, inputs) =>
      new Promise((resolve, reject) => {
        calls.push({
          inputs,
          finish: (fail) => {
            if (fail) {
              reject(fail);
              return;
            }
            resolve(inputs.map((input) => `done ${input}`));
          },
        });
      }),
    weigh: () => 1,
    maxWeight: 3,
  });
  return { calls, call };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('coalescer', () => {
  it('makes the first call at once and sends those that wait together', async () => {
    const { calls, call } = destination();
    const first = call('a', 1);
    const waiting = [call('a', 2), call('a', 3)];
    await settle();
    expect(calls.map((entry) => entry.inputs)).toEqual([[1]]);

    calls[0]!.finish();
    expect(await first).toBe('done 1');
    await settle();
    expect(calls.map((entry) => entry.inputs)).toEqual([[1], [2, 3]]);
    calls[1]!.finish();
    expect(await Promise.all(waiting)).toEqual(['done 2', 'done 3']);
  });

  it('keeps destinations apart', async () => {
    const { calls, call } = destination();
    const both = [call('a', 1), call('b', 2)];
    await settle();
    expect(calls.map((entry) => entry.inputs)).toEqual([[1], [2]]);
    calls[0]!.finish();
    calls[1]!.finish();
    expect(await Promise.all(both)).toEqual(['done 1', 'done 2']);
  });

  it('takes no more than a batch holds and sends the rest next', async () => {
    const { calls, call } = destination();
    const all = [1, 2, 3, 4, 5, 6].map((input) => call('a', input));
    await settle();
    calls[0]!.finish();
    await settle();
    expect(calls[1]!.inputs).toEqual([2, 3, 4]);
    calls[1]!.finish();
    await settle();
    expect(calls[2]!.inputs).toEqual([5, 6]);
    calls[2]!.finish();
    expect(await Promise.all(all)).toEqual(
      [1, 2, 3, 4, 5, 6].map((input) => `done ${input}`)
    );
  });

  it('fails every call of a batch that fails, and carries on with the next', async () => {
    const { calls, call } = destination();
    const first = call('a', 1).catch((error: Error) => error.message);
    const second = call('a', 2).catch((error: Error) => error.message);
    const third = call('a', 3).catch((error: Error) => error.message);
    await settle();
    calls[0]!.finish();
    await settle();
    calls[1]!.finish(new Error('the partition is overloaded'));
    expect(await Promise.all([first, second, third])).toEqual([
      'done 1',
      'the partition is overloaded',
      'the partition is overloaded',
    ]);

    const after = call('a', 4);
    await settle();
    calls[2]!.finish();
    expect(await after).toBe('done 4');
  });
});
