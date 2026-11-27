import {
  isNonEmptyString,
  isNumber,
  isObjectOrFunction,
} from './predicates.js';
import type { Json } from './serialization.js';

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
 * Asks for the next retry no sooner than `retryAfterMs` from the failure, for
 * example to honour an HTTP `Retry-After` header.
 *
 * The delay is a floor. The retry policy's own delay still applies when it is
 * longer, the retry still counts against `maxAttempts`, and the error is
 * terminal on the last attempt like any other.
 *
 * @example
 * ```ts
 * if (response.status === 429) {
 *   // Retry-After is either delay-seconds or an HTTP date.
 *   const header = response.headers.get('Retry-After') ?? '';
 *   const seconds = Number(header);
 *   const at = Date.parse(header);
 *   const delayMs = Number.isFinite(seconds) ? seconds * 1000 : at - Date.now();
 *   throw new RetryAfterError('Rate limited', Math.max(0, delayMs || 0));
 * }
 * ```
 */
export class RetryAfterError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryAfterError';

    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new RangeError('retryAfterMs must be a non-negative finite number');
    }

    this.retryAfterMs = retryAfterMs;
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
  constructor(entity: string, cause?: unknown) {
    super(
      `Retry policy for ${entity} must produce a non-negative safe-integer timestamp`
    );
    this.name = 'DurableRetryPolicyError';

    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause });
    }
  }
}

/** Error persisted when a successful result cannot be JSON-serialized. */
export class DurableResultSerializationError extends Error {
  constructor(operation: string, cause?: unknown) {
    super(
      `Result for durable operation "${operation}" is not JSON-serializable`
    );
    this.name = 'DurableResultSerializationError';

    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause });
    }
  }
}

/**
 * Error persisted when a memoized result cannot be JSON-serialized. It is
 * terminal because every retry would fail the same way.
 */
export class DurableMemoSerializationError extends NonRetryableError {
  constructor(key: string, cause?: unknown) {
    super(
      `Memoized result for key ${JSON.stringify(key)} is not JSON-serializable`
    );
    this.name = 'DurableMemoSerializationError';

    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause });
    }
  }
}

/**
 * Error persisted when work memoizes more keys, or a larger result, than the
 * limits allow. It is terminal because every retry would fail the same way.
 */
export class DurableMemoLimitError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = 'DurableMemoLimitError';
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

/** Thrown when an idempotency key is reused for the same operation with a different payload. */
export class DuplicateDurablePayloadError extends Error {
  constructor(id: string, operation: string) {
    super(
      `Durable call "${id}" for operation "${operation}" was registered with a different payload`
    );
    this.name = 'DuplicateDurablePayloadError';
  }
}

/**
 * Error thrown when a fanout delivery is settled twice.
 *
 * The first `ack`, `retry`, or `deadLetter` call is binding. A second call on
 * the same delivery, or a call from a stale stub kept across deliveries, is a
 * consumer bug and fails loudly instead of being silently ignored.
 */
export class FanoutSettlementError extends Error {
  constructor(id: string, outcome?: string) {
    super(
      outcome === undefined
        ? `Fanout delivery "${id}" is stale`
        : `Fanout delivery "${id}" was already settled as "${outcome}"`
    );
    this.name = 'FanoutSettlementError';
  }
}

/** Error recorded when a target delivery exceeds its configured timeout. */
export class FanoutTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Fanout delivery timed out after ${timeoutMs}ms`);
    this.name = 'FanoutTimeoutError';
  }
}

/** Error recorded when an outbox `publish` call exceeds its configured timeout. */
export class OutboxTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Outbox publication timed out after ${timeoutMs}ms`);
    this.name = 'OutboxTimeoutError';
  }
}

/** Outcome error of a scheduled run that exceeded `runTimeoutMs`. */
export class ScheduledRunTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Scheduled run timed out after ${timeoutMs}ms`);
    this.name = 'ScheduledRunTimeoutError';
  }
}

/**
 * Outcome error of a scheduled run that was still marked running when no live
 * instance was executing it, for example after its object was evicted or reset.
 */
export class ScheduledRunInterruptedError extends Error {
  constructor() {
    super('Scheduled run was interrupted before it reported an outcome');
    this.name = 'ScheduledRunInterruptedError';
  }
}

/** Error recorded when one `onOutcome` delivery exceeds `outcomeTimeoutMs`. */
export class ScheduledOutcomeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Scheduled run outcome delivery timed out after ${timeoutMs}ms`);
    this.name = 'ScheduledOutcomeTimeoutError';
  }
}

/** A definite rejection before the batch was durably accepted. */
export class FanoutEnqueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FanoutEnqueueError';
  }
}

/** A definite rejection before records were durably appended. */
export class LogAppendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogAppendError';
  }
}

/**
 * Thrown when a read starts below the retained window, so a consumer that
 * falls further behind than retention learns it lost records instead of
 * silently skipping them.
 */
export class LogTruncatedError extends Error {
  constructor(
    readonly requestedOffset: number,
    readonly oldestOffset: number
  ) {
    super(
      `Log offset ${requestedOffset} was trimmed; the oldest retained offset is ${oldestOffset}`
    );
    this.name = 'LogTruncatedError';
  }
}

/**
 * Thrown when settling a lease that no longer exists, was already settled, or
 * was reclaimed by another worker. A stale ack must fail loudly rather than
 * advance a range someone else now owns.
 */
export class LogLeaseError extends Error {
  constructor(batchId: string) {
    super(`Log lease "${batchId}" is not held`);
    this.name = 'LogLeaseError';
  }
}

/** A malformed or unexpected semaphore message. */
export class SemaphoreProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemaphoreProtocolError';
  }
}

/** Error thrown when a sharding function returns an invalid shard key. */
export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingError';
  }
}

export type SerializedError = { name: string; message: string };

type ErrorFields = {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  retryAfterMs?: unknown;
};

const readString = (
  value: ErrorFields,
  property: keyof ErrorFields
): string | undefined => {
  const candidate = readField(value, property);

  return isNonEmptyString(candidate) ? candidate : undefined;
};

const readField = (
  value: ErrorFields,
  property: keyof ErrorFields
): unknown => {
  try {
    return value[property];
  } catch {
    return undefined;
  }
};

/** Reduces any thrown value to a persistable name and message, never throwing. */
export const serializeError = (cause: unknown): SerializedError => {
  if (cause === null) {
    return { name: 'Error', message: 'null' };
  }

  if (!isObjectOrFunction(cause)) {
    return { name: 'Error', message: String(cause) };
  }

  return {
    name: readString(cause, 'name') ?? 'Error',
    message: readString(cause, 'message') ?? 'Unknown thrown value',
  };
};

export const isErrorInstance = <Instance extends Error>(
  error: unknown,
  constructor: new (...args: never[]) => Instance
): error is Instance => {
  try {
    return error instanceof constructor;
  } catch {
    return false;
  }
};

/** Recognizes this package's NonRetryableError and same-named errors from other packages. */
export const isNonRetryable = (cause: unknown): boolean => {
  if (isErrorInstance(cause, NonRetryableError)) {
    return true;
  }

  if (!isObjectOrFunction(cause)) {
    return false;
  }

  if (readString(cause, 'name') === 'NonRetryableError') {
    return true;
  }

  try {
    const constructor = cause.constructor;

    return (
      isObjectOrFunction(constructor) &&
      readString(constructor, 'name') === 'NonRetryableError'
    );
  } catch {
    return false;
  }
};

/** Reads RetryAfterError's retry floor, including same-named errors from other package copies. */
export const retryAfterMsOf = (cause: unknown): number => {
  if (!isObjectOrFunction(cause)) {
    return 0;
  }

  const isRetryAfterError =
    isErrorInstance(cause, RetryAfterError) ||
    readString(cause, 'name') === 'RetryAfterError';

  if (!isRetryAfterError) {
    return 0;
  }

  const retryAfterMs = readField(cause, 'retryAfterMs');

  return isNumber(retryAfterMs) &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
    ? retryAfterMs
    : 0;
};

/** Fields logged with a failure to identify the work that failed. */
type FailureDetails = { readonly [field: string]: Json };

export const reportFailure = (
  event: string,
  details: FailureDetails,
  cause: unknown
): void => {
  try {
    const stack = isObjectOrFunction(cause)
      ? readString(cause, 'stack')
      : undefined;

    const logged: SerializedError & { stack?: string } = {
      ...serializeError(cause),
    };

    if (stack) {
      logged.stack = stack;
    }

    console.error({
      event,
      ...details,
      error: logged,
    });
  } catch {
    return;
  }
};

/** A definite rejection of a topology change or configuration. */
export class TopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TopologyError';
  }
}

/** Why a topology client could not use the published snapshot. */
export type TopologyFallbackReason =
  | 'missing'
  | 'invalid'
  | 'timeout'
  | 'error';

/**
 * Thrown by a topology client when the published snapshot is unusable and no
 * configured fallback produced one. The client never asks the coordinator.
 */
export class TopologyUnavailableError extends Error {
  constructor(
    readonly group: string,
    readonly reason: TopologyFallbackReason,
    options?: { cause?: unknown }
  ) {
    super(`Topology for group "${group}" is unavailable: ${reason}`);
    this.name = 'TopologyUnavailableError';

    if (options?.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause });
    }
  }
}
