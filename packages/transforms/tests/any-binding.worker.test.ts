import { env } from 'cloudflare:test';
import { Result } from 'better-result';
import { describe, expect, it } from 'vitest';
import {
  createTransformStub,
  defineTransform,
  errorBoundary,
  retry,
  timeout,
} from '../src/index';

type Call = { method: string; args: unknown[] };

const recorder = defineTransform<object>().caller(
  (calls: Call[]) =>
    async ({ method, args, next }) => {
      calls.push({ method, args });
      return next();
    }
);

describe('Vite plugin coverage', () => {
  it('does not wrap KV, R2, or Workflow bindings', () => {
    expect(Reflect.get(env.KV, 'with')).toBeUndefined();
    expect(Reflect.get(env.BUCKET, 'with')).toBeUndefined();
    expect(Reflect.get(env.WORKFLOW, 'with')).toBeUndefined();
  });
});

describe('KV through createTransformStub', () => {
  it('runs caller transforms around put, get, list, and delete', async () => {
    const calls: Call[] = [];
    const kv = createTransformStub(env.KV)
      .with(timeout, 1_000)
      .with(recorder, calls);

    await kv.put('greeting', 'hello');
    // @ts-expect-error -- .with() collapses KVNamespace.get overloads to the string[] signature
    await expect(kv.get('greeting')).resolves.toBe('hello');
    await expect(
      // @ts-expect-error -- .with() collapses KVNamespace.get overloads to the string[] signature
      kv.get('greeting', 'json').catch(() => 'not-json')
    ).resolves.toBe('not-json');
    const listed = await kv.list({ prefix: 'greet' });
    expect(listed.keys.map((key) => key.name)).toEqual(['greeting']);
    await kv.delete('greeting');
    // @ts-expect-error -- .with() collapses KVNamespace.get overloads to the string[] signature
    await expect(kv.get('greeting')).resolves.toBeNull();

    expect(calls.map((call) => call.method)).toEqual([
      'put',
      'get',
      'get',
      'list',
      'delete',
      'get',
    ]);
  });

  it('retries real binding errors and wraps them with errorBoundary', async () => {
    const calls: Call[] = [];
    const kv = createTransformStub(env.KV)
      .with(errorBoundary)
      .with(retry, { retries: 2, delay: () => 0 })
      .with(recorder, calls);

    const result = await kv.put('x'.repeat(1_000), 'too long');

    expect(Result.isError(result)).toBe(true);
    expect(String(Result.isError(result) && result.error)).toMatch(/key/i);
    expect(calls).toHaveLength(3);
  });
});

describe('R2 through createTransformStub', () => {
  it('runs caller transforms around put, get, head, and delete', async () => {
    const calls: Call[] = [];
    const bucket = createTransformStub(env.BUCKET).with(recorder, calls);

    await bucket.put('file.txt', 'contents');
    const object = await bucket.get('file.txt');
    await expect(object?.text()).resolves.toBe('contents');
    await expect(bucket.head('file.txt')).resolves.toMatchObject({
      key: 'file.txt',
      size: 8,
    });
    await bucket.delete('file.txt');
    await expect(bucket.get('file.txt')).resolves.toBeNull();

    expect(calls.map((call) => call.method)).toEqual([
      'put',
      'get',
      'head',
      'delete',
      'get',
    ]);
  });

  it('streams a request body through a transformed put', async () => {
    const bucket = createTransformStub(env.BUCKET).with(timeout, 1_000);
    const body = new Blob(['streamed']).stream();

    await bucket.put('stream.txt', body, {
      httpMetadata: { contentType: 'text/plain' },
    });

    const object = await bucket.get('stream.txt');
    expect(object?.httpMetadata?.contentType).toBe('text/plain');
    await expect(object?.text()).resolves.toBe('streamed');
  });
});

describe('Workflows through createTransformStub', () => {
  it('runs caller transforms around create and get', async () => {
    const calls: Call[] = [];
    const workflow = createTransformStub(env.WORKFLOW).with(recorder, calls);

    const created = await workflow.create({
      id: 'transform-probe',
      params: { value: 'hi' },
    });
    const fetched = await workflow.get(created.id);

    expect(fetched.id).toBe('transform-probe');
    expect(calls.map((call) => call.method)).toEqual(['create', 'get']);
  });

  it('does not transform methods on the returned WorkflowInstance', async () => {
    const calls: Call[] = [];
    const workflow = createTransformStub(env.WORKFLOW).with(recorder, calls);

    const instance = await workflow.create({ params: { value: 'nested' } });
    await instance.status();

    expect(calls.map((call) => call.method)).toEqual(['create']);
  });
});

describe('Durable Object promise pipelining', () => {
  it('cannot pipeline through a plugin-wrapped stub', () => {
    const stub = env.PIPELINE_DO.getByName('pipeline');

    expect(() =>
      (stub.counter() as unknown as { increment(): unknown }).increment()
    ).toThrow(/increment is not a function/);
  });

  it('works through a plugin-wrapped stub when each hop is awaited', async () => {
    const counter = await env.PIPELINE_DO.getByName('awaited').counter();

    await expect(counter.increment()).resolves.toBe(1);
  });

  it('can pipeline through an unwrapped stub', async () => {
    const namespace = env.PIPELINE_DO;
    const raw = Reflect.apply(namespace.getByName, namespace, [
      'pipeline',
    ]) as DurableObjectStub<import('./test-worker').PipelineDO>;

    await expect(raw.counter().increment()).resolves.toBe(1);
  });
});
