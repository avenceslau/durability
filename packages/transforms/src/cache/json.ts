import { isBoolean, isNumber, isObject, isString } from '../predicates.js';

/** A value that reads back unchanged after a JSON round trip. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

type JsonCheck<T> = T extends string | number | boolean | null
  ? true
  : T extends (...args: never[]) => unknown
    ? false
    : T extends readonly (infer Item)[]
      ? JsonCheck<Item>
      : T extends object
        ?
            | true
            | {
                // JSON drops undefined properties, which reads back as an
                // absent optional property.
                [Key in keyof T]-?: JsonCheck<Exclude<T[Key], undefined>>;
              }[keyof T]
        : false;

/**
 * `true` when every value of `T` reads back unchanged after a JSON round trip.
 * Unlike assigning to {@link Json}, interfaces pass this check.
 */
export type IsJson<T> = false extends JsonCheck<T> ? false : true;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isObject(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};

/**
 * Returns `value` as JSON with `undefined` object properties dropped. Throws a
 * `TypeError` naming `path` for anything else JSON cannot hold.
 */
export function toJson(value: unknown, path: string): Json {
  if (value === null || isString(value) || isBoolean(value)) {
    return value;
  }

  if (isNumber(value) && Number.isFinite(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    // Array.from visits holes, which then fail as undefined.
    return Array.from(value, (item: unknown, index) =>
      toJson(item, `${path}[${index}]`)
    );
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        item === undefined ? [] : [[key, toJson(item, `${path}.${key}`)]]
      )
    );
  }

  throw new TypeError(`${path} is not a JSON value`);
}

/** JSON text with object keys sorted at every depth, so equal values encode equally. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (value === null || !isObject(value)) {
    return JSON.stringify(value);
  }

  const members = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`);

  return `{${members.join(',')}}`;
}

/** Encodes a method result, keeping an `undefined` result distinct from `null`. */
export function encodeResult(value: unknown): string {
  return JSON.stringify(
    value === undefined ? {} : { value: toJson(value, 'result') }
  );
}

/** Reads a result written by {@link encodeResult}. Throws a `TypeError` on anything else. */
export function decodeResult(text: string): Json | undefined {
  const parsed: unknown = JSON.parse(text);

  if (!isPlainObject(parsed)) {
    throw new TypeError('Cached result is not a JSON object');
  }

  return Object.prototype.hasOwnProperty.call(parsed, 'value')
    ? toJson(parsed['value'], 'result')
    : undefined;
}
