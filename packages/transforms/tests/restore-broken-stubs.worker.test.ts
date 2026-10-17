import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTransformStub, retry } from '../src/index';

// Aliasing env hides the binding from the plugin, so its stubs stay raw.
const bindings = env;

describe('restoreBrokenStubs over real RPC', () => {
  it('leaves an unrewritten stub broken after the object aborts', async () => {
    const stub = bindings.CONTEXT_DO.getByName('raw-abort');

    // Vitest leaves a raw RpcPromise rejection unhandled; adopt it first.
    await expect(Promise.resolve(stub.abort('broken'))).rejects.toThrow(
      'broken'
    );
    await expect(Promise.resolve(stub.ping())).rejects.toThrow('broken');
  });

  it('replaces the stub for the next call after the object aborts', async () => {
    const stub = env.CONTEXT_DO.getByName('restore-abort');

    await expect(stub.abort('broken')).rejects.toThrow('broken');
    await expect(stub.ping()).resolves.toBe('pong');
  });

  it('cannot retry through a raw stub once the object aborts', async () => {
    const stub = createTransformStub(
      bindings.CONTEXT_DO.getByName('raw-retry')
    ).with(retry, { retries: 1, delay: () => 0 });

    await expect(stub.abortOnce('raw-retry')).rejects.toThrow('broken');
  });

  it('retries on a replaced stub when the first attempt aborts', async () => {
    const stub = env.CONTEXT_DO.getByName('restore-retry').with(retry, {
      retries: 1,
      delay: () => 0,
    });

    await expect(stub.abortOnce('restore-retry')).resolves.toBe('recovered');
  });
});
