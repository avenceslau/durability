import { Err, Ok, Result, ResultDeserializationError } from 'better-result';
import { defineTransform, type EmptyTransformContext } from '../define.js';

const betterResultEnvelopeKey = '__durability_transforms_better_result_v1';

/** Caller compatibility options for {@link betterResultCodec}. */
export type BetterResultCodecOptions = {
  /** Decode unmarked responses emitted by version 0.1.0. Defaults to false. */
  acceptLegacy?: boolean;
};

/**
 * Serializes Better Result values on the callee and rehydrates them on the caller.
 *
 * New responses use a versioned envelope so ordinary domain objects with an
 * `ok` or `error` status pass through unchanged. Set `acceptLegacy` only while
 * callers still communicate with version 0.1.0 callees.
 *
 * @example
 * ```ts
 * applyTransforms(MyDurableObject, {
 *   all: [registerTransform(betterResultCodec)],
 * });
 *
 * const result = await stub.with(betterResultCodec).read();
 * ```
 */
export const betterResultCodec = Object.assign(
  defineTransform<object, EmptyTransformContext>()
    .caller(
      (options: BetterResultCodecOptions | undefined) =>
        async ({ next }) => {
          const value = await next();
          if (typeof value === 'object' && value !== null) {
            const envelope = Reflect.get(value, betterResultEnvelopeKey);
            if (typeof envelope === 'object' && envelope !== null) {
              if (Reflect.get(envelope, 'version') !== 1) {
                throw new TypeError(
                  'Unsupported Better Result envelope version'
                );
              }
              const result = Result.deserialize(
                Reflect.get(envelope, 'result')
              );
              if (
                Result.isError(result) &&
                ResultDeserializationError.is(result.error)
              ) {
                throw new TypeError('Invalid Better Result envelope');
              }
              return result;
            }
          }

          if (options?.acceptLegacy === true) {
            const legacy = Result.deserialize(value);
            if (
              !Result.isError(legacy) ||
              !ResultDeserializationError.is(legacy.error)
            ) {
              return legacy;
            }
          }
          return value;
        }
    )
    .callee((_options: void) => async ({ next }) => {
      const value = await next();
      if (!(value instanceof Ok) && !(value instanceof Err)) {
        return value;
      }

      const serialized = Result.serialize(value);
      return {
        ...serialized,
        [betterResultEnvelopeKey]: { version: 1, result: serialized },
      };
    }),
  { callerResult: 'better-result-codec' as const }
);
