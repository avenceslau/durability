import { Result } from 'better-result';
import { defineTransform, type EmptyTransformContext } from '../define.js';

/**
 * Converts caller-visible throws into `better-result` error values.
 *
 * @example
 * ```ts
 * const result = await stub.with(errorBoundary).read();
 * if (Result.isError(result)) {
 *   console.error(result.error);
 * }
 * ```
 */
export const errorBoundary = Object.assign(
  defineTransform<object, EmptyTransformContext>().caller(
    (_options: void) =>
      async ({ next }) => {
        try {
          return Result.ok(await next());
        } catch (error) {
          return Result.err(error);
        }
      }
  ),
  { callerResult: 'better-result' as const }
);
