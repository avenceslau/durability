import { isBoolean, isNumber, isObject, isString } from '../predicates.js';

/** A value JSON text can represent. */
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
 * `true` when `T` is made only of strings, numbers, booleans, null, arrays and
 * plain objects. Interfaces pass, although they are not assignable to {@link Json}.
 */
export type IsJson<T> = false extends JsonCheck<T> ? false : true;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isObject(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};

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

export function canonicalJson(json: Json): string {
  if (Array.isArray(json)) {
    return `[${json.map(canonicalJson).join(',')}]`;
  }

  if (json === null || !isObject(json)) {
    return JSON.stringify(json);
  }

  const members = Object.entries(json)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);

  return `{${members.join(',')}}`;
}

export function encodeResult(value: unknown): string {
  return JSON.stringify(
    value === undefined ? {} : { value: toJson(value, 'result') }
  );
}

export function decodeResult(text: string): Json | undefined {
  const parsed: unknown = JSON.parse(text);

  if (!isPlainObject(parsed)) {
    throw new TypeError('Cached result is not a JSON object');
  }

  return Object.prototype.hasOwnProperty.call(parsed, 'value')
    ? toJson(parsed['value'], 'result')
    : undefined;
}
