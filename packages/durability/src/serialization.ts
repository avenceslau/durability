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

type Json = ReturnType<typeof z.json>['_output'];

const canonicalize = (value: Json): Json => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key] as Json)])
    );
  }
  return value;
};

/**
 * The stored form with object keys sorted at every depth, so two payloads
 * compare equal when they carry the same data regardless of key order.
 */
export const canonical = (stored: string): string =>
  JSON.stringify(canonicalize(JSON.parse(stored) as Json));
