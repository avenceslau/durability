import { Result } from 'better-result';
import type { Result as BetterResult } from 'better-result';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  CallerTimeoutError,
  abortAsSuccess,
  applyTransforms,
  betterResultCodec,
  createTransformStub,
  errorBoundary,
  largeObjectStream,
  registerTransform,
  retry,
  timeout,
} from './index';

class ResultService {
  async success() {
    return Result.ok(42);
  }

  async plain() {
    return 'plain';
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
      largeObjectStream
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

  it('retries failures up to the configured limit', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue('done');
    const service = createTransformStub({ operation }).with(retry, 2);

    expectTypeOf(service.operation).returns.toEqualTypeOf<Promise<string>>();
    await expect(service.operation()).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('preserves the final retry error', async () => {
    const failure = new Error('still unavailable');
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
    const service = createTransformStub({ operation }).with(retry, {
      retries: 1,
    });

    await expect(service.operation()).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
