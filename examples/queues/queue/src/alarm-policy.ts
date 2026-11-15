import { exponential, jitter } from 'durability/utils';

/**
 * For an alarm that is the only thing driving a piece of work. By default an
 * alarm gives up after five failed attempts, which would leave that work with
 * nothing scheduled; these keep trying, at most a minute apart.
 */
export const neverGiveUp = {
  retryTimeouts: true,
  retries: {
    maxAttempts: Number.MAX_SAFE_INTEGER,
    delay: (attempt: number) => jitter(exponential(attempt, 1_000, 60_000)),
  },
};
