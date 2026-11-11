import * as v from 'valibot';

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isJson = (value: unknown): value is Json => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    // `every` would skip the holes of a sparse array, which are not JSON.
    for (const item of value) {
      if (!isJson(item)) {
        return false;
      }
    }
    return true;
  }
  return isPlainObject(value) && Object.values(value).every(isJson);
};

// Not built from `v.record`, which silently drops `constructor` and `prototype` keys.
export const jsonSchema = v.custom<Json>(isJson, 'Invalid JSON value');

const storedValueSchema = v.variant('kind', [
  v.object({ kind: v.literal('value'), value: jsonSchema }),
  v.object({ kind: v.literal('undefined') }),
]);

/**
 * What `JSON.stringify` would produce: `undefined` properties are dropped and
 * `undefined` array elements become `null`. `jsonSchema` rejects both as given,
 * although they are routine in values such as lifecycle events whose handler
 * returned nothing.
 */
const asJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : asJson(item)));
  }
  // Only plain objects are rewritten; anything else must fail validation as is.
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, asJson(item)])
  );
};

// Wrapping preserves a successful `undefined` result, which bare JSON cannot represent.
export const serialize = (value: unknown): string =>
  JSON.stringify(
    value === undefined
      ? { kind: 'undefined' }
      : { kind: 'value', value: v.parse(jsonSchema, asJson(value)) }
  );

export const deserialize = (value: string): unknown => {
  const stored = v.parse(storedValueSchema, JSON.parse(value));
  return stored.kind === 'undefined' ? undefined : stored.value;
};

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
