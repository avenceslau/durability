import { Result } from 'better-result';
import { defineTransform, type EmptyTransformContext } from '../define.js';

/**
 * Converts Cloudflare Durable Object reset errors into successful undefined
 * Better Results while preserving ordinary errors.
 *
 * Use this only when a reset is an expected success condition for the method.
 */
export const abortAsSuccess = Object.assign(
  defineTransform<object, EmptyTransformContext>().caller(
    (_options: void) =>
      async ({ next }) => {
        try {
          return Result.ok(await next());
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'durableObjectReset' in error &&
            error.durableObjectReset === true
          ) {
            return Result.ok(undefined);
          }

          throw error;
        }
      }
  ),
  { callerResult: 'abort-as-success' as const }
);
