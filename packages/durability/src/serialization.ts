import { z } from 'zod';

const storedValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.json() }),
  z.object({ kind: z.literal('undefined') }),
]);

// Wrapping preserves a successful `undefined` result, which bare JSON cannot represent.
export const serialize = (value: unknown): string =>
  JSON.stringify(
    value === undefined
      ? { kind: 'undefined' }
      : { kind: 'value', value: z.json().parse(value) }
  );

export const deserialize = (value: string): unknown => {
  const stored = storedValueSchema.parse(JSON.parse(value));
  return stored.kind === 'undefined' ? undefined : stored.value;
};
