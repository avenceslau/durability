/**
 * Marks a handler failure as terminal so it is persisted without another retry.
 *
 * Use this for permanent failures such as invalid input. Transient errors should
 * be thrown normally so the configured retry policy can handle them.
 *
 * @example
 * ```ts
 * if (!recipient.isValid) {
 *   throw new NonRetryableError('Recipient is invalid');
 * }
 * ```
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/**
 * Error recorded when a handler attempt exceeds its configured timeout.
 *
 * Durability creates this error and aborts the attempt's signal; consumers do
 * not need to throw it themselves. Timeout failures follow the normal retry
 * policy and are exposed by `getResult` if they become terminal.
 */
export class DurableAttemptTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Durable operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'DurableAttemptTimeoutError';
  }
}

/** Error recorded when a named alarm attempt exceeds its configured timeout. */
export class DurableAlarmTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Durable alarm "${name}" timed out after ${timeoutMs}ms`);
    this.name = 'DurableAlarmTimeoutError';
  }
}

/** Error persisted when retry-delay evaluation fails or is unsafe. */
export class DurableRetryPolicyError extends Error {
  constructor(entity: string, reason?: unknown) {
    super(
      `Retry policy for ${entity} must produce a non-negative safe-integer timestamp`
    );
    this.name = 'DurableRetryPolicyError';
    if (reason !== undefined) {
      Object.defineProperty(this, 'cause', { value: reason });
    }
  }
}

/** Error persisted when a successful result cannot be JSON-serialized. */
export class DurableResultSerializationError extends Error {
  constructor(operation: string, reason?: unknown) {
    super(
      `Result for durable operation "${operation}" is not JSON-serializable`
    );
    this.name = 'DurableResultSerializationError';
    if (reason !== undefined) {
      Object.defineProperty(this, 'cause', { value: reason });
    }
  }
}

/** Error persisted when pending work has already reached its attempt limit. */
export class DurableAttemptsExhaustedError extends Error {
  constructor(entity: 'operation' | 'named alarm', name: string, max: number) {
    super(`Durable ${entity} "${name}" exhausted its ${max} attempts`);
    this.name = 'DurableAttemptsExhaustedError';
  }
}

/**
 * Error thrown when an idempotency key is reused for another operation.
 *
 * A call ID permanently identifies its original operation so `getResult` cannot
 * return a value with the wrong inferred type.
 */
export class DuplicateDurableCallError extends Error {
  constructor(
    id: string,
    existingOperation: string,
    requestedOperation: string
  ) {
    super(
      `Durable call "${id}" already belongs to operation "${existingOperation}", not "${requestedOperation}"`
    );
    this.name = 'DuplicateDurableCallError';
  }
}

export type SerializedError = { name: string; message: string };

const readString = (value: object, property: string): string | undefined => {
  try {
    const candidate = Reflect.get(value, property);
    return typeof candidate === 'string' && candidate.length > 0
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/** Reduces any thrown value to a persistable name and message, never throwing. */
export const serializeError = (error: unknown): SerializedError => {
  if (error === null) {
    return { name: 'Error', message: 'null' };
  }
  if (typeof error !== 'object' && typeof error !== 'function') {
    return { name: 'Error', message: String(error) };
  }
  return {
    name: readString(error, 'name') ?? 'Error',
    message: readString(error, 'message') ?? 'Unknown thrown value',
  };
};

export const isErrorInstance = (
  error: unknown,
  constructor: new (...args: never[]) => Error
): boolean => {
  try {
    return error instanceof constructor;
  } catch {
    return false;
  }
};

/** Recognizes this package's NonRetryableError and same-named errors from other packages. */
export const isNonRetryable = (error: unknown): boolean => {
  if (isErrorInstance(error, NonRetryableError)) {
    return true;
  }
  if (
    (typeof error !== 'object' && typeof error !== 'function') ||
    error === null
  ) {
    return false;
  }
  if (readString(error, 'name') === 'NonRetryableError') {
    return true;
  }
  try {
    const constructor = Reflect.get(error, 'constructor');
    return (
      constructor !== null &&
      (typeof constructor === 'object' || typeof constructor === 'function') &&
      readString(constructor, 'name') === 'NonRetryableError'
    );
  } catch {
    return false;
  }
};

export const reportFailure = (
  event: string,
  details: Record<string, unknown>,
  error: unknown
): void => {
  try {
    const stack =
      error !== null &&
      (typeof error === 'object' || typeof error === 'function')
        ? readString(error, 'stack')
        : undefined;
    console.error({
      event,
      ...details,
      error: { ...serializeError(error), ...(stack ? { stack } : {}) },
    });
  } catch {
    return;
  }
};
