import { z } from 'zod';
import { exponential, jitter } from './utils.js';

/**
 * Retry policy shared by all methods or overridden for one method.
 *
 * The delay callback owns the complete scheduling policy, so it can compose the
 * helpers exported from `durability/utils` or use an application-specific
 * strategy.
 *
 * @example
 * ```ts
 * import { exponential, jitter } from 'durability/utils';
 *
 * const retries: DurabilityRetryOptions = {
 *   maxAttempts: 5,
 *   delay: (attempt) => jitter(exponential(attempt)),
 * };
 * ```
 */
export type DurabilityRetryOptions = {
  /** Returns the delay in milliseconds after a failed attempt. */
  delay?: (attempt: number) => number;
  /** The total number of attempts, including the initial attempt. Defaults to 5. */
  maxAttempts?: number;
};

/** Execution policy overrides for one durable operation method. */
export type DurabilityMethodOptions = {
  /** Maximum duration of one attempt in milliseconds. */
  attemptTimeoutMs?: number;
  /** Retry policy overrides for this method. */
  retries?: DurabilityRetryOptions;
};

/** Execution policy overrides for one named alarm. */
export type DurabilityAlarmMethodOptions = DurabilityMethodOptions & {
  /** Retry timed-out attempts only when their side effects are idempotent or reconciled. */
  retryTimeouts?: boolean;
};

/** Policy options shared by durable operations and named alarms. */
export type ExecutionPolicyOptions = {
  /** Maximum duration of one handler attempt. Defaults to 5 minutes. */
  attemptTimeoutMs?: number;
  /** Retry policy shared by handlers without a method-level override. */
  retries?: DurabilityRetryOptions;
};

export type AttemptPolicy = {
  attemptTimeoutMs: number;
  delay: (attempt: number) => number;
  maxAttempts: number;
};

const functionSchema = <T>() =>
  z.custom<T>((value) => typeof value === 'function');

const retryOptionsSchema = z.object({
  delay: functionSchema<(attempt: number) => number>().optional(),
  maxAttempts: z.number().optional(),
});

export const methodOptionsSchema = z.object({
  attemptTimeoutMs: z.number().optional(),
  retries: retryOptionsSchema.optional(),
});

export const alarmMethodOptionsSchema = methodOptionsSchema.extend({
  retryTimeouts: z.boolean().optional(),
});

export type MethodPolicy = z.infer<typeof methodOptionsSchema>;
export type AlarmMethodPolicy = z.infer<typeof alarmMethodOptionsSchema>;

export const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
};

const assertMethodOptions = (prefix: string, method: MethodPolicy): void => {
  if (method.attemptTimeoutMs !== undefined) {
    assertPositiveInteger(
      `${prefix}.attemptTimeoutMs`,
      method.attemptTimeoutMs
    );
  }
  if (method.retries?.maxAttempts !== undefined) {
    assertPositiveInteger(
      `${prefix}.retries.maxAttempts`,
      method.retries.maxAttempts
    );
  }
};

/**
 * Validates global and per-method policy options once and resolves the
 * effective policy for a method name.
 */
export type PolicyResolver<Method> = (
  name: string
) => AttemptPolicy & { method: Method | undefined };

export const createPolicyResolver = <Method extends MethodPolicy>(
  options: ExecutionPolicyOptions,
  methods: Record<string, unknown>,
  methodSchema: z.ZodType<Method>
): PolicyResolver<Method> => {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 5 * 60_000;
  const retries = retryOptionsSchema.parse(options.retries ?? {});
  const delay =
    retries.delay ?? ((attempt: number) => jitter(exponential(attempt)));
  const maxAttempts = retries.maxAttempts ?? 5;
  assertPositiveInteger('attemptTimeoutMs', attemptTimeoutMs);
  assertPositiveInteger('retries.maxAttempts', maxAttempts);

  const parsed = new Map(
    Object.entries(methods).map(([name, method]) => {
      const valid = methodSchema.parse(method);
      assertMethodOptions(`methods.${name}`, valid);
      return [name, valid];
    })
  );

  return (name) => {
    const method = parsed.get(name);
    return {
      method,
      attemptTimeoutMs: method?.attemptTimeoutMs ?? attemptTimeoutMs,
      delay: method?.retries?.delay ?? delay,
      maxAttempts: method?.retries?.maxAttempts ?? maxAttempts,
    };
  };
};
