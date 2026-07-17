import { env } from 'cloudflare:test';
import { Result } from 'better-result';
import { describe, expect, it } from 'vitest';
import {
  abortAsSuccess,
  betterResultCodec,
  largeObjectStream,
} from '../src/index';
import { crossWorkerObservability } from './cross-worker-service';
import { observability, serviceObservability } from './test-worker';

describe('Durable Object context promise pipelining', () => {
  it('passes caller context to callee transforms without explicit wrapping', async () => {
    const stub = env.CONTEXT_DO.get(env.CONTEXT_DO.idFromName('context')).with(
      observability,
      { requestId: 'request-1' }
    );

    await expect(stub.greet('Ada')).resolves.toEqual({
      metricName: 'do_rpc_calls',
      requestId: 'request-1',
      value: 'Hello, Ada',
    });
  });

  it('rehydrates Better Result values over real RPC', async () => {
    const stub = env.CONTEXT_DO.get(
      env.CONTEXT_DO.idFromName('better-result')
    ).with(betterResultCodec);

    const result = await stub.result();
    expect(Result.isOk(result)).toBe(true);
    expect(Result.unwrap(result)).toBe(42);
  });

  it('streams and reconstructs large objects over real RPC', async () => {
    const stub = env.CONTEXT_DO.get(
      env.CONTEXT_DO.idFromName('large-object')
    ).with(largeObjectStream, {
      schema: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value) => ({ value }),
        },
      },
    });

    await expect(stub.largeObject(256)).resolves.toEqual({
      payload: 'x'.repeat(256),
    });
  });

  it('converts Durable Object abort errors into successful Results', async () => {
    const stub = env.CONTEXT_DO.get(env.CONTEXT_DO.idFromName('abort')).with(
      abortAsSuccess
    );

    const result = await stub.abort('intentional abort');
    expect(Result.isOk(result)).toBe(true);
    expect(Result.unwrap(result)).toBeUndefined();
  });

  it('passes context through a WorkerEntrypoint service binding', async () => {
    const service = env.CONTEXT_SERVICE.with(serviceObservability, {
      requestId: 'service-request-1',
    });

    await expect(service.greet('Ada')).resolves.toEqual({
      metricName: 'service_rpc_calls',
      requestId: 'service-request-1',
      value: 'Hello from service, Ada',
    });
  });

  it('passes context through a cross-worker entrypoint binding', async () => {
    const service = env.CROSS_WORKER_SERVICE.with(crossWorkerObservability, {
      requestId: 'cross-worker-request-1',
    });

    await expect(service.greet('Ada')).resolves.toEqual({
      metricName: 'cross_worker_rpc_calls',
      requestId: 'cross-worker-request-1',
      value: 'Hello from another worker, Ada',
    });
  });
});
