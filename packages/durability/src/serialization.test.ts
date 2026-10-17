import { describe, expect, it } from 'vitest';
import { deserialize, serialize } from './serialization';

describe('serialize', () => {
  it('round-trips JSON values and a bare undefined', () => {
    for (const value of [null, 0, 'x', [1, 'a', null], { a: { b: [true] } }]) {
      expect(deserialize(serialize(value))).toEqual(value);
    }
    expect(deserialize(serialize(undefined))).toBeUndefined();
  });

  it('treats undefined inside a value the way JSON.stringify does', () => {
    expect(
      deserialize(
        serialize({
          outcome: 'completed',
          result: undefined,
          nested: { gone: undefined, kept: 1 },
        })
      )
    ).toEqual({ outcome: 'completed', nested: { kept: 1 } });
    expect(deserialize(serialize([1, undefined, 2]))).toEqual([1, null, 2]);
  });

  it('still rejects values that are not JSON', () => {
    expect(() => serialize({ when: new Date(0) })).toThrow('Invalid input');
    expect(() => serialize(() => undefined)).toThrow('Invalid input');
    expect(() => serialize({ big: 1n })).toThrow('Invalid input');
  });
});
