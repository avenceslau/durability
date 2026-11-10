import type { StandardSchemaV1 } from '@standard-schema/spec';
import { defineTransform, type EmptyTransformContext } from '../define.js';

/** Callee configuration for {@link largeObjectStream}. */
export type LargeObjectStreamOptions = {
  /** Maximum object size encoded by the callee. Defaults to 8 MiB. */
  maxEncodeBytes?: number;
  /** Encoded size that switches an object result to streaming. Defaults to 1 MiB. */
  thresholdBytes?: number;
};

/** Caller configuration for {@link largeObjectStream}. */
export type LargeObjectStreamCallerOptions = {
  /** Maximum encoded payload accepted by the caller. Defaults to 8 MiB. */
  maxDecodeBytes?: number;
  /** Runtime validator for the reconstructed JSON value. */
  schema: StandardSchemaV1<unknown, unknown>;
};

/** Error thrown when an object exceeds the callee's encode limit. */
export class LargeObjectEncodeLimitError extends Error {
  constructor(readonly maxEncodeBytes: number) {
    super(`Large object result exceeded ${maxEncodeBytes} bytes`);
    this.name = 'LargeObjectEncodeLimitError';
  }
}

/** Error thrown when a streamed object exceeds the caller's decode limit. */
export class LargeObjectDecodeLimitError extends Error {
  constructor(readonly maxDecodeBytes: number) {
    super(`Large object stream exceeded ${maxDecodeBytes} bytes`);
    this.name = 'LargeObjectDecodeLimitError';
  }
}

/** Error thrown when a streamed object fails runtime schema validation. */
export class LargeObjectValidationError extends Error {
  constructor(readonly issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super('Large object stream failed schema validation');
    this.name = 'LargeObjectValidationError';
  }
}

const largeObjectStreamHeader = new TextEncoder().encode(
  'do-transforms-large-object-v1'
);

/**
 * Streams large JSON object results and reconstructs them on the caller.
 *
 * Install the callee side with the desired threshold and attach the caller side
 * to the stub. Existing `ReadableStream` results pass through unchanged. Object
 * values use JSON serialization, so non-JSON values do not round-trip. The
 * transform bypasses RPC value-size limits but still buffers the complete JSON
 * representation; use native streams for unbounded data.
 *
 * @example
 * ```ts
 * applyTransforms(MyDurableObject, {
 *   methods: {
 *     snapshot: [
 *       registerTransform(largeObjectStream, { thresholdBytes: 1_000_000 }),
 *     ],
 *   },
 * });
 *
 * const snapshot = await stub.with(largeObjectStream, {
 *   schema: snapshotSchema,
 * }).snapshot();
 * ```
 */
export const largeObjectStream = defineTransform<
  object,
  EmptyTransformContext
>()
  .caller((options: LargeObjectStreamCallerOptions) => {
    const maxDecodeBytes = options.maxDecodeBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(maxDecodeBytes) || maxDecodeBytes <= 0) {
      throw new RangeError('maxDecodeBytes must be a positive safe integer');
    }

    return async ({ next }) => {
      const value = await next();
      if (!(value instanceof ReadableStream)) {
        return value;
      }

      const reader = value.getReader();
      const first = await reader.read();
      const isEncoded =
        !first.done &&
        first.value instanceof Uint8Array &&
        first.value.byteLength >= largeObjectStreamHeader.byteLength &&
        largeObjectStreamHeader.every(
          (byte, index) => byte === first.value[index]
        );

      if (!isEncoded) {
        let firstPending = true;
        return new ReadableStream<unknown>({
          async pull(controller) {
            const chunk = firstPending ? first : await reader.read();
            firstPending = false;
            if (chunk.done) {
              controller.close();
            } else {
              controller.enqueue(chunk.value);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
      }

      const decoder = new TextDecoder('utf-8', { fatal: true });
      const firstPayload = first.value.subarray(
        largeObjectStreamHeader.byteLength
      );
      let decodedBytes = firstPayload.byteLength;
      if (decodedBytes > maxDecodeBytes) {
        const error = new LargeObjectDecodeLimitError(maxDecodeBytes);
        void reader.cancel(error);
        throw error;
      }

      try {
        let json = decoder.decode(firstPayload, { stream: true });
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- Stream chunks must be decoded in order.
          const chunk = await reader.read();
          if (chunk.done) {
            json += decoder.decode();
            break;
          }
          if (!(chunk.value instanceof Uint8Array)) {
            throw new TypeError('Large object stream chunks must be bytes');
          }
          decodedBytes += chunk.value.byteLength;
          if (decodedBytes > maxDecodeBytes) {
            throw new LargeObjectDecodeLimitError(maxDecodeBytes);
          }
          json += decoder.decode(chunk.value, { stream: true });
        }

        const parsed: unknown = JSON.parse(json);
        const result = await options.schema['~standard'].validate(parsed);
        if (result.issues) {
          throw new LargeObjectValidationError(result.issues);
        }
        return parsed;
      } catch (error) {
        void reader.cancel(error);
        throw error;
      }
    };
  })
  .callee((options: LargeObjectStreamOptions | undefined) => {
    const maxEncodeBytes = options?.maxEncodeBytes ?? 8 * 1024 * 1024;
    const thresholdBytes = options?.thresholdBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(maxEncodeBytes) || maxEncodeBytes <= 0) {
      throw new RangeError('maxEncodeBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes <= 0) {
      throw new RangeError('thresholdBytes must be a positive safe integer');
    }
    if (thresholdBytes > maxEncodeBytes) {
      throw new RangeError('thresholdBytes cannot exceed maxEncodeBytes');
    }

    return async ({ next }) => {
      const value = await next();
      if (
        typeof value !== 'object' ||
        value === null ||
        value instanceof ReadableStream
      ) {
        return value;
      }

      const json = JSON.stringify(value);
      if (json === undefined) {
        return value;
      }

      const bytes = new TextEncoder().encode(json);
      if (bytes.byteLength > maxEncodeBytes) {
        throw new LargeObjectEncodeLimitError(maxEncodeBytes);
      }
      if (bytes.byteLength < thresholdBytes) {
        return value;
      }

      let offset = -1;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === -1) {
            controller.enqueue(largeObjectStreamHeader);
            offset = 0;
            return;
          }

          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }

          const end = Math.min(offset + 64 * 1024, bytes.byteLength);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      });
    };
  });
