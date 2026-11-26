// Runtime checks for RPC stubs, registrations, and results that reach a
// transform without a TypeScript contract. They only inspect `typeof`, so
// they never read a property of the value.

export const isString = (value: unknown): value is string =>
  typeof value === 'string';

export const isNumber = (value: unknown): value is number =>
  typeof value === 'number';

export const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';

export const isFunction = (value: unknown): value is Function =>
  typeof value === 'function';

/** Excludes functions, unlike {@link isObjectOrFunction}. */
export const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

export const isObjectOrFunction = (value: unknown): value is object =>
  isObject(value) || isFunction(value);
