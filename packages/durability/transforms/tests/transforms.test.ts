import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Result } from 'better-result';
import type { Result as BetterResult } from 'better-result';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  CallerTimeoutError,
  LargeObjectDecodeLimitError,
  LargeObjectValidationError,
  abortAsSuccess,
  applyTransforms,
  betterResultCodec,
  createTransformStub,
  errorBoundary,
  largeObjectStream,
  registerTransform,
  retry,
  timeout,
} from '../src/index';

const unknownSchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value: unknown) => ({ value }),
  },
};

class ResultService {
  async success() {
    return Result.ok(42);
  }

  async plain() {
    return 'plain';
  }

  async domainStatus() {
    return { status: 'ok' as const, detail: 'ordinary value' };
  }
}

applyTransforms(ResultService, {
  all: [registerTransform(betterResultCodec)],
});

class LargeObjectService {
  async value(payload: string) {
    return { payload };
  }

  async stream() {
    return new Blob(['original stream']).stream();
  }
}

applyTransforms(LargeObjectService, {
  all: [
    registerTransform(largeObjectStream, {
      thresholdBytes: 32,
    }),
  ],
});

function assertRetryOptionTypes() {
  const service = createTransformStub({ operation: async () => 'done' });

  service.with(retry, {
    retries: 3,
    delay: ({ error, attempt }) => {
      expectTypeOf(error).toEqualTypeOf<unknown>();
      expectTypeOf(attempt).toEqualTypeOf<number>();
      return attempt * 10;
    },
  });
  service.with(retry, {
    retries: 3,
    // @ts-expect-error delay must return milliseconds
    delay: () => '10',
  });
  service.with(retry, {
    retries: 3,
    // @ts-expect-error removed retry option
    baseDelayMs: 100,
  });
}
void assertRetryOptionTypes;

describe('built-in transforms', () => {
  it('serializes and rehydrates Better Result values', async () => {
    const service = createTransformStub(new ResultService()).with(
      betterResultCodec
    );

    const result = await service.success();
    expectTypeOf(result).toMatchTypeOf<BetterResult<number, never>>();
    expect(Result.isOk(result)).toBe(true);
    expect(Result.unwrap(result)).toBe(42);
    await expect(service.plain()).resolves.toBe('plain');
    await expect(service.domainStatus()).resolves.toEqual({
      status: 'ok',
      detail: 'ordinary value',
    });
  });

  it('decodes legacy Better Result payloads only when requested', async () => {
    const service = createTransformStub({
      read: async () => ({ status: 'ok' as const, value: 42 }),
    });

    await expect(
      service.with(betterResultCodec, { acceptLegacy: false }).read()
    ).resolves.toEqual({
      status: 'ok',
      value: 42,
    });
    const legacy = await service.with(betterResultCodec).read();
    expect(Result.isOk(legacy)).toBe(true);
    expect(Result.unwrap(legacy)).toBe(42);
  });

  it('times out caller operations', async () => {
    const service = createTransformStub({
      wait: () => new Promise<never>(() => undefined),
    }).with(timeout, 5);

    expectTypeOf(service.wait).returns.toEqualTypeOf<Promise<never>>();
    await expect(service.wait()).rejects.toEqual(
      new CallerTimeoutError('wait', 5)
    );
  });

  it('converts thrown values into Better Result errors', async () => {
    const failure = new Error('unavailable');
    const service = createTransformStub({
      succeed: async () => 'done' as const,
      fail: async () => {
        throw failure;
      },
    }).with(errorBoundary);

    expectTypeOf(service.succeed).returns.toEqualTypeOf<
      Promise<BetterResult<'done', unknown>>
    >();
    expectTypeOf(service.fail).returns.toEqualTypeOf<
      Promise<BetterResult<never, unknown>>
    >();
    await expect(service.succeed()).resolves.toEqual(Result.ok('done'));

    const result = await service.fail();
    expect(Result.isError(result)).toBe(true);
    expect(result).toMatchObject({ status: 'error', error: failure });
  });

  it('streams and reconstructs objects over the configured size', async () => {
    const service = createTransformStub(new LargeObjectService()).with(
      largeObjectStream,
      { schema: unknownSchema }
    );

    expectTypeOf(service.value).returns.toEqualTypeOf<
      Promise<{ payload: string }>
    >();
    expectTypeOf(service.stream).returns.toEqualTypeOf<
      Promise<ReadableStream<Uint8Array<ArrayBuffer>>>
    >();
    await expect(service.value('x'.repeat(64))).resolves.toEqual({
      payload: 'x'.repeat(64),
    });
    await expect(new Response(await service.stream()).text()).resolves.toBe(
      'original stream'
    );
  });

  it('bounds and validates streamed object decoding', async () => {
    const service = createTransformStub(new LargeObjectService()).with(
      largeObjectStream,
      { maxDecodeBytes: 32, schema: unknownSchema }
    );
    await expect(service.value('x'.repeat(64))).rejects.toBeInstanceOf(
      LargeObjectDecodeLimitError
    );

    const validated = createTransformStub(new LargeObjectService()).with(
      largeObjectStream,
      {
        maxDecodeBytes: 1_024,
        schema: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate(value) {
              return typeof value === 'object' && value !== null
                ? { value }
                : { issues: [{ message: 'Expected object' }] };
            },
          },
        },
      }
    );
    await expect(validated.value('x'.repeat(64))).resolves.toEqual({
      payload: 'x'.repeat(64),
    });

    const rejected = createTransformStub(new LargeObjectService()).with(
      largeObjectStream,
      {
        schema: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate: () => ({ issues: [{ message: 'Rejected' }] }),
          },
        },
      }
    );
    await expect(rejected.value('x'.repeat(64))).rejects.toBeInstanceOf(
      LargeObjectValidationError
    );
  });

  it('preserves native streams at the minimum threshold', async () => {
    class MinimumThresholdService extends LargeObjectService {}
    applyTransforms(MinimumThresholdService, {
      all: [
        registerTransform(largeObjectStream, {
          thresholdBytes: 1,
        }),
      ],
    });

    const service = createTransformStub(new MinimumThresholdService()).with(
      largeObjectStream,
      { schema: unknownSchema }
    );
    await expect(new Response(await service.stream()).text()).resolves.toBe(
      'original stream'
    );
  });

  it('converts Durable Object abort errors into successful Results', async () => {
    const service = createTransformStub({
      abort: async () => {
        throw Object.assign(new Error('reset'), { durableObjectReset: true });
      },
    }).with(abortAsSuccess);

    expectTypeOf(service.abort).returns.toEqualTypeOf<
      Promise<BetterResult<undefined, never>>
    >();
    const result = await service.abort();
    expect(Result.isOk(result)).toBe(true);
    expect(Result.unwrap(result)).toBeUndefined();
  });

  it('does not capture ordinary errors as Durable Object aborts', async () => {
    const failure = new Error('ordinary failure');
    const service = createTransformStub({
      fail: async () => {
        throw failure;
      },
    }).with(abortAsSuccess);

    await expect(service.fail()).rejects.toBe(failure);
  });

  it('retries failures with an attempt-aware delay', async () => {
    const firstFailure = new Error('first');
    const secondFailure = new Error('second');
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(firstFailure)
      .mockRejectedValueOnce(secondFailure)
      .mockResolvedValue('done');
    const delay =
      vi.fn<(context: { error: unknown; attempt: number }) => void>();
    const service = createTransformStub({ operation }).with(retry, {
      retries: 2,
      delay: ({ error, attempt }) => {
        expectTypeOf(error).toEqualTypeOf<unknown>();
        expectTypeOf(attempt).toEqualTypeOf<number>();
        delay({ error, attempt });
        return 0;
      },
    });

    expectTypeOf(service.operation).returns.toEqualTypeOf<Promise<string>>();
    await expect(service.operation()).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenNthCalledWith(1, {
      error: firstFailure,
      attempt: 1,
    });
    expect(delay).toHaveBeenNthCalledWith(2, {
      error: secondFailure,
      attempt: 2,
    });
  });

  it('uses jittered exponential delay by default', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValue('done');
      const service = createTransformStub({ operation }).with(retry, {
        retries: 1,
      });

      const result = service.operation();
      await vi.advanceTimersByTimeAsync(49);
      expect(operation).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe('done');
      expect(operation).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('preserves the final retry error', async () => {
    const failure = new Error('still unavailable');
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
    const service = createTransformStub({ operation }).with(retry, {
      retries: 1,
      delay: () => 0,
    });

    await expect(service.operation()).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
