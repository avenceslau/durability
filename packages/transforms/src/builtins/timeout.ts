import { defineTransform, type EmptyTransformContext } from '../define.js';

/**
 * Error thrown when a caller-side timeout expires.
 *
 * The remote RPC is not cancelled; only the caller stops waiting for it.
 */
export class CallerTimeoutError extends Error {
  /** RPC method whose caller deadline expired. */
  readonly method: string;
  /** Configured caller deadline in milliseconds. */
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`RPC call to ${method} timed out after ${timeoutMs}ms`);
    this.name = 'CallerTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Rejects a caller RPC with {@link CallerTimeoutError} after a deadline.
 *
 * This transform does not abort the remote method. Use it to bound caller wait
 * time, not as a guarantee that remote work or side effects stopped.
 *
 * @example
 * ```ts
 * await stub.with(timeout, 5_000).read();
 * ```
 */
export const timeout = defineTransform<object, EmptyTransformContext>().caller(
  (timeoutMs: number) =>
    async ({ method, next }) => {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new RangeError('timeoutMs must be a non-negative finite number');
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          next(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new CallerTimeoutError(method, timeoutMs)),
              timeoutMs
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    }
);
