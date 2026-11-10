import { defineTransform, type EmptyTransformContext } from '../define.js';

/** Configuration for the caller-side {@link retry} transform. */
export type RetryOptions = {
  /** Number of retries after the initial call. */
  retries: number;
  /** Returns the delay before the next call; `attempt` is one-based. */
  delay?: (context: {
    /** Error thrown by the preceding call. */
    error: unknown;
    /** One-based retry attempt about to be scheduled. */
    attempt: number;
  }) => number | Promise<number>;
};

/**
 * Repeats a failed RPC sequentially according to a caller-side retry policy.
 *
 * Each retry is a new RPC invocation. Only use this with idempotent methods or
 * pass an idempotency key, because the caller cannot know whether a failed call
 * performed remote side effects before its error was observed.
 *
 * @example
 * ```ts
 * await stub.with(retry, {
 *   retries: 3,
 *   delay: ({ attempt }) => Math.min(1_000 * 2 ** (attempt - 1), 30_000),
 * }).write({ idempotencyKey: 'write:123' });
 * ```
 */
export const retry = defineTransform<object, EmptyTransformContext>().caller(
  (options: RetryOptions | number) =>
    async ({ next }) => {
      const { retries, delay } =
        typeof options === 'number' ? { retries: options } : options;

      if (!Number.isInteger(retries) || retries < 0) {
        throw new RangeError('retries must be a non-negative integer');
      }

      for (let attempt = 0; ; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop -- Retry attempts must run sequentially.
          return await next();
        } catch (error) {
          if (attempt >= retries) {
            throw error;
          }

          const retryAttempt = attempt + 1;
          const pendingDelay = delay
            ? delay({ error, attempt: retryAttempt })
            : Math.random() * Math.min(100 * 2 ** (retryAttempt - 1), 30_000);
          // eslint-disable-next-line no-await-in-loop -- Retry delays may depend on the current failure.
          const delayMs = await pendingDelay;
          if (!Number.isFinite(delayMs) || delayMs < 0) {
            throw new RangeError(
              'retry delay must be a non-negative finite number'
            );
          }
          if (delayMs > 0) {
            // eslint-disable-next-line no-await-in-loop -- Backoff must finish before the next attempt.
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }
    }
);
