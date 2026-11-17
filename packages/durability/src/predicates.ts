import type { Json, JsonObject } from './serialization.js';

// Runtime checks for values JavaScript callers, storage, and peers hand in
// without a TypeScript contract.

export const isString = (value: unknown): value is string =>
  typeof value === 'string';

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export const isNumber = (value: unknown): value is number =>
  typeof value === 'number';

export const isFunction = (value: unknown): value is Function =>
  typeof value === 'function';

/** Excludes functions, unlike {@link isObjectOrFunction}. */
export const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

export const isObjectOrFunction = (value: unknown): value is object =>
  isObject(value) || isFunction(value);

export const isJsonObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
