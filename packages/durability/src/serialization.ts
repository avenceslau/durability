import { z } from 'zod';

const storedValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.json() }),
  z.object({ kind: z.literal('undefined') }),
]);

/**
 * What `JSON.stringify` would produce: `undefined` properties are dropped and
 * `undefined` array elements become `null`. `z.json()` rejects both as given,
 * although they are routine in values such as lifecycle events whose handler
 * returned nothing.
 */
const asJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : asJson(item)));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Only plain objects are rewritten; anything else must fail validation as is.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, asJson(item)])
    );
  }
  return value;
};

// Wrapping preserves a successful `undefined` result, which bare JSON cannot represent.
export const serialize = (value: unknown): string =>
  JSON.stringify(
    value === undefined
      ? { kind: 'undefined' }
      : { kind: 'value', value: z.json().parse(asJson(value)) }
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
