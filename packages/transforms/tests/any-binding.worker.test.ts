import { env } from 'cloudflare:test';
import { Result } from 'better-result';
import { describe, expect, it } from 'vitest';
import { defineTransform, errorBoundary, retry, timeout } from '../src/index';

type Call = { method: string; args: unknown[] };

const recorder = defineTransform<object>().caller(
  (calls: Call[]) =>
    async ({ method, args, next }) => {
      calls.push({ method, args });
      return next();
    }
);

describe('Vite plugin coverage', () => {
  it('wraps KV, R2, and Workflow bindings', () => {
    expect(env.KV.with).toBeTypeOf('function');
    expect(env.BUCKET.with).toBeTypeOf('function');
    expect(env.WORKFLOW.with).toBeTypeOf('function');
  });
});

describe('KV', () => {
  it('runs caller transforms around put, get, list, and delete', async () => {
    const calls: Call[] = [];
    const kv = env.KV.with(timeout, 1_000).with(recorder, calls);

    await kv.put('greeting', 'hello');
    await expect(kv.get('greeting')).resolves.toBe('hello');
    await expect(kv.get('greeting', 'json')).rejects.toThrow(SyntaxError);
    const listed = await kv.list({ prefix: 'greet' });
    expect(listed.keys.map((key) => key.name)).toEqual(['greeting']);
    await kv.delete('greeting');
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
    const kv = env.KV.with(errorBoundary)
      .with(retry, { retries: 2, delay: () => 0 })
      .with(recorder, calls);

    const result = await kv.put('x'.repeat(1_000), 'too long');

    expect(Result.isError(result)).toBe(true);
    expect(String(Result.isError(result) && result.error)).toMatch(/key/i);
    expect(calls).toHaveLength(3);
  });
});

describe('R2', () => {
  it('runs caller transforms around put, get, head, and delete', async () => {
    const calls: Call[] = [];
    const bucket = env.BUCKET.with(recorder, calls);

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
    const bucket = env.BUCKET.with(timeout, 1_000);
    const body = new Blob(['streamed']).stream();

    await bucket.put('stream.txt', body, {
      httpMetadata: { contentType: 'text/plain' },
    });

    const object = await bucket.get('stream.txt');
    expect(object?.httpMetadata?.contentType).toBe('text/plain');
    await expect(object?.text()).resolves.toBe('streamed');
  });

  it('keeps synchronous methods synchronous without transforms', () => {
    const upload = env.BUCKET.resumeMultipartUpload('sync.txt', 'upload-id');

    expect(upload.key).toBe('sync.txt');
  });

  it('pipelines through synchronous methods with transforms', async () => {
    const calls: Call[] = [];
    const bucket = env.BUCKET.with(recorder, calls);

    await expect(
      bucket.resumeMultipartUpload('sync.txt', 'upload-id')
    ).resolves.toMatchObject({ key: 'sync.txt', uploadId: 'upload-id' });
    expect(calls.map((call) => call.method)).toEqual(['resumeMultipartUpload']);
  });
});

describe('Workflows', () => {
  it('runs caller transforms around create and get', async () => {
    const calls: Call[] = [];
    const workflow = env.WORKFLOW.with(recorder, calls);

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
    const workflow = env.WORKFLOW.with(recorder, calls);

    const instance = await workflow.create({ params: { value: 'nested' } });
    await expect(instance.status()).resolves.toHaveProperty('status');

    expect(calls.map((call) => call.method)).toEqual(['create']);
  });
});

describe('Durable Object promise pipelining', () => {
  it('pipelines through a plugin-wrapped stub without transforms', async () => {
    const stub = env.PIPELINE_DO.getByName('pipeline');

    await expect(stub.counter().increment()).resolves.toBe(1);
  });

  it('pipelines through a stub with transforms', async () => {
    const calls: Call[] = [];
    const stub = env.PIPELINE_DO.getByName('pipeline').with(recorder, calls);

    await expect(stub.counter().increment()).resolves.toBe(1);
    expect(calls.map((call) => call.method)).toEqual(['counter']);
  });

  it('rejects pipelined calls when the transformed call fails', async () => {
    const stub = env.PIPELINE_DO.getByName('pipeline').with(timeout, 1_000);

    await expect(stub.fail().increment()).rejects.toThrow('pipeline failure');
  });

  it('reads RPC properties through wrapped stubs', async () => {
    const stub = env.PIPELINE_DO.getByName('pipeline');

    await expect(stub.label).resolves.toBe('pipeline');
    await expect(stub.with(timeout, 1_000).label).resolves.toBe('pipeline');
  });
});
