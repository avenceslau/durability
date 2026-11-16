// Declares the queue's bindings. Imported here so that a Worker importing this
// module's types gets them too: the queue's code is typed against them.
import './env';
import { WorkerEntrypoint, env } from 'cloudflare:workers';
import * as v from 'valibot';
import * as admin from './admin';
import { loadOptionsSchema, type LoadControl } from './load';
import {
  queueNameSchema,
  sendSchema,
  targetNameSchema,
  consumerNameSchema,
  type MessageInput,
  type Overview,
  type PullBatch,
  type RedriveStatus,
} from './model';
import { orchestrators, pullConsumers, redrivers } from './namespaces';
import type { PullOptions } from './pull-consumer';
import { send, UnknownQueueError, type SendOutcome } from './send';

export { Directory } from './directory';
export { Limiter } from './limiter';
export { Orchestrator } from './orchestrator';
export { Partition } from './partition';
export { PullConsumer } from './pull-consumer';
export { Redriver } from './redriver';

/**
 * For other Workers: bind this entrypoint as a service and call it directly,
 * without a token or an HTTP round trip.
 */
export class QueueBinding extends WorkerEntrypoint<Cloudflare.Env> {
  send(queue: string, messages: MessageInput[]): Promise<SendOutcome> {
    return send(queue, v.parse(sendSchema, messages));
  }

  /**
   * Starts replaying every dead letter of the queue, or only those of one
   * target, and returns at once. `redriveStatus` reports how far it got.
   */
  redrive(queue: string, target?: string): Promise<RedriveStatus> {
    return redrivers()
      .getByName(v.parse(queueNameSchema, queue))
      .start(
        queue,
        target === undefined ? undefined : v.parse(targetNameSchema, target)
      );
  }

  redriveStatus(queue: string): Promise<RedriveStatus | undefined> {
    return redrivers().getByName(v.parse(queueNameSchema, queue)).status();
  }

  /**
   * Hands the named consumer its next messages from a queue that has pull
   * consumers enabled, or nothing when it has caught up. Acknowledge them
   * with the batch's `lease`, or they are handed out again.
   */
  pull(
    queue: string,
    consumer: string,
    options?: PullOptions
  ): Promise<PullBatch | undefined> {
    return pullConsumer(queue, consumer).pull(queue, options);
  }

  ack(queue: string, consumer: string, lease: string): Promise<boolean> {
    return pullConsumer(queue, consumer).ack(lease);
  }

  nack(queue: string, consumer: string, lease: string): Promise<boolean> {
    return pullConsumer(queue, consumer).nack(lease);
  }
}

/**
 * For Workers that manage queues. It is a separate entrypoint from
 * `QueueBinding` so that a Worker bound only to send and pull cannot create,
 * reconfigure, or delete a queue.
 */
export class QueueAdmin extends WorkerEntrypoint<Cloudflare.Env> {
  list() {
    return admin.listQueues();
  }

  create(queue: string, settings?: admin.SettingsInput): Promise<void> {
    return admin.createQueue(queue, settings);
  }

  /** Changes the settings that are given and keeps the rest. */
  updateSettings(queue: string, changes: admin.SettingsInput): Promise<void> {
    return admin.updateSettings(queue, changes);
  }

  putTarget(
    queue: string,
    target: string,
    settings: admin.TargetInput
  ): Promise<void> {
    return admin.putTarget(queue, target, settings);
  }

  pauseTarget(queue: string, target: string, paused: boolean): Promise<void> {
    return admin.pauseTarget(queue, target, paused);
  }

  removeTarget(queue: string, target: string): Promise<void> {
    return admin.removeTarget(queue, target);
  }

  resize(queue: string, partitions: number): Promise<void> {
    return admin.resize(queue, partitions);
  }

  overview(queue: string): Promise<Overview> {
    return admin.overview(queue);
  }

  delete(queue: string): Promise<void> {
    return admin.deleteQueue(queue);
  }
}

/** One object per consumer of a queue: it holds that consumer's positions. */
const pullConsumer = (queue: string, consumer: string) =>
  pullConsumers().getByName(
    `${v.parse(queueNameSchema, queue)}/${v.parse(consumerNameSchema, consumer)}`
  );

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const digest = async (text: string): Promise<ArrayBuffer> =>
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

/** Compares digests, so the time taken says nothing about where two tokens differ. */
const matches = async (given: string, expected: string): Promise<boolean> => {
  const left = new Uint8Array(await digest(given));
  const right = new Uint8Array(await digest(expected));
  let difference = 0;
  for (const [index, byte] of left.entries()) {
    difference |= byte ^ right[index]!;
  }
  return difference === 0;
};

const bearer = (request: Request): string | undefined =>
  request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];

/**
 * The admin API has no sign-in of its own: whatever stands in front of the
 * Worker decides who reaches it, which the README says must be Cloudflare
 * Access. A browser signed in there sends its Access cookie with requests
 * made by any page, so a request that states an origin has to state this
 * one. Every browser states it on a WebSocket and on anything but a plain
 * read; a script or `curl` states none.
 */
const fromAnotherSite = (request: Request): boolean => {
  const origin = request.headers.get('Origin');
  return origin !== null && origin !== new URL(request.url).origin;
};

const parse = async <Schema extends v.GenericSchema>(
  schema: Schema,
  request: Request
): Promise<v.InferOutput<Schema>> => {
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(400, 'The request body must be JSON');
  });
  const result = v.safeParse(schema, body);
  if (!result.success) {
    throw new HttpError(
      400,
      result.issues.map((issue) => issue.message).join('; ')
    );
  }
  return result.output;
};

const name = <Schema extends v.GenericSchema>(
  schema: Schema,
  value: string | undefined
): v.InferOutput<Schema> => {
  const result = v.safeParse(schema, value);
  if (!result.success) {
    throw new HttpError(404, 'Not found');
  }
  return result.output;
};

const accept = async (queue: string, request: Request): Promise<Response> => {
  const outcome = await send(queue, await parse(sendSchema, request));
  const backpressure = outcome.rejected.some(
    (rejection) => rejection.error.name === 'Backpressure'
  );
  const status = outcome.rejected.length === 0 ? 202 : backpressure ? 429 : 503;
  return Response.json(outcome, { status });
};

/** A pull consumer asks for messages, or settles the ones it was given. */
const consume = async (
  queue: string,
  consumer: string,
  action: string | undefined,
  request: Request
): Promise<Response> => {
  const stub = pullConsumer(queue, consumer);
  if (action === 'pull') {
    const options = await parse(
      v.object({
        batches: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
        visibilityMs: v.optional(
          v.pipe(v.number(), v.safeInteger(), v.minValue(1_000))
        ),
      }),
      request
    );
    const batch = await stub.pull(queue, {
      ...(options.batches === undefined ? {} : { batches: options.batches }),
      ...(options.visibilityMs === undefined
        ? {}
        : { visibilityMs: options.visibilityMs }),
    });
    return Response.json(batch ?? null);
  }
  if (action !== 'ack' && action !== 'nack') {
    throw new HttpError(404, 'Not found');
  }

  const { lease } = await parse(v.object({ lease: v.string() }), request);
  const settled =
    action === 'ack' ? await stub.ack(lease) : await stub.nack(lease);
  // A lease that ran out was handed to someone else under a new name.
  return Response.json({ settled }, { status: settled ? 200 : 409 });
};

/**
 * The dashboard's load test. The load itself comes from another Worker, bound
 * as `LOADGEN`; without that binding the dashboard is told there is none.
 */
const load = async (request: Request, action?: string): Promise<Response> => {
  const control = (env as unknown as { LOADGEN?: LoadControl }).LOADGEN;
  if (!control) {
    if (request.method === 'GET' && action === undefined) {
      return Response.json({ available: false });
    }
    throw new HttpError(404, 'This queue has no load generator bound');
  }

  if (action === 'queues' && request.method === 'DELETE') {
    return Response.json({ deleted: await control.deleteQueues() });
  }
  if (action !== undefined) {
    throw new HttpError(404, 'Not found');
  }
  // Where the dashboard shows the run, for whoever started it from a script.
  const url = new URL('/#/load', request.url).href;
  if (request.method === 'GET') {
    return Response.json({ available: true, url, ...(await control.status()) });
  }
  if (request.method === 'POST') {
    const options = await parse(loadOptionsSchema, request);
    return Response.json(
      { url, ...(await control.start(options)) },
      { status: 202 }
    );
  }
  if (request.method === 'DELETE') {
    return Response.json({ url, ...(await control.stop()) });
  }
  throw new HttpError(405, 'Method not allowed');
};

const queues = async (request: Request): Promise<Response> => {
  if (request.method === 'GET') {
    return Response.json(await admin.listQueues());
  }
  if (request.method !== 'POST') {
    throw new HttpError(405, 'Method not allowed');
  }

  const input = await parse(
    v.object({
      name: queueNameSchema,
      settings: v.optional(v.unknown(), {}),
    }),
    request
  );
  await admin.createQueue(input.name, input.settings as admin.SettingsInput);
  return Response.json({ name: input.name }, { status: 201 });
};

const queue = async (
  request: Request,
  queueName: string,
  rest: string[]
): Promise<Response> => {
  const [resource, targetSegment, action] = rest;
  const done = new Response(null, { status: 204 });

  if (resource === undefined && request.method === 'GET') {
    return Response.json(await admin.overview(queueName));
  }
  if (resource === undefined && request.method === 'PATCH') {
    await admin.updateSettings(
      queueName,
      (await parse(v.unknown(), request)) as admin.SettingsInput
    );
    return done;
  }
  if (resource === undefined && request.method === 'DELETE') {
    await admin.deleteQueue(queueName);
    return done;
  }
  if (resource === 'socket') {
    return orchestrators().getByName(queueName).fetch(request);
  }
  if (resource === 'messages' && request.method === 'POST') {
    return accept(queueName, request);
  }
  if (resource === 'redrive' && request.method === 'POST') {
    const status = await redrivers().getByName(queueName).start(queueName);
    return Response.json(status, { status: 202 });
  }
  if (resource === 'redrive' && request.method === 'GET') {
    const status = await redrivers().getByName(queueName).status();
    return Response.json(status ?? null);
  }
  if (resource === 'resize' && request.method === 'POST') {
    const { partitions } = await parse(
      v.object({ partitions: v.number() }),
      request
    );
    await admin.resize(queueName, partitions);
    return done;
  }

  if (resource !== 'targets' || targetSegment === undefined) {
    throw new HttpError(404, 'Not found');
  }
  const target = name(targetNameSchema, targetSegment);

  if (action === undefined && request.method === 'PUT') {
    await admin.putTarget(
      queueName,
      target,
      (await parse(v.unknown(), request)) as admin.TargetInput
    );
    return done;
  }
  if (action === undefined && request.method === 'DELETE') {
    await admin.removeTarget(queueName, target);
    return done;
  }
  if (action === 'pause' && request.method === 'POST') {
    const { paused } = await parse(v.object({ paused: v.boolean() }), request);
    await admin.pauseTarget(queueName, target, paused);
    return done;
  }
  if (action === 'redrive' && request.method === 'POST') {
    const status = await redrivers()
      .getByName(queueName)
      .start(queueName, target);
    return Response.json(status, { status: 202 });
  }
  throw new HttpError(404, 'Not found');
};

const route = async (request: Request): Promise<Response> => {
  const [root, ...segments] = new URL(request.url).pathname
    .split('/')
    .filter((segment) => segment.length > 0);

  if (root === 'queues' && request.method === 'POST') {
    const [queueSegment, resource, consumerSegment, action] = segments;
    const queueName = name(queueNameSchema, queueSegment);
    const token = bearer(request);
    if (resource === 'messages') {
      if (token === undefined || !(await matches(token, env.PRODUCER_TOKEN))) {
        throw new HttpError(401, 'A producer token is required');
      }
      return accept(queueName, request);
    }
    if (resource === 'consumers') {
      if (token === undefined || !(await matches(token, env.CONSUMER_TOKEN))) {
        throw new HttpError(401, 'A consumer token is required');
      }
      return consume(
        queueName,
        name(consumerNameSchema, consumerSegment),
        action,
        request
      );
    }
  }
  if (root === 'queues') {
    throw new HttpError(404, 'Not found');
  }

  if (root !== 'api') {
    throw new HttpError(404, 'Not found');
  }
  const [resource, queueSegment, ...rest] = segments;
  if (fromAnotherSite(request)) {
    throw new HttpError(403, 'Requests from other sites are refused');
  }
  if (resource === 'load') {
    return load(request, queueSegment);
  }
  if (resource !== 'queues') {
    throw new HttpError(404, 'Not found');
  }
  if (queueSegment === undefined) {
    return queues(request);
  }
  return queue(request, name(queueNameSchema, queueSegment), rest);
};

export default {
  async fetch(request): Promise<Response> {
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof HttpError) {
        return Response.json(
          { error: error.message },
          { status: error.status }
        );
      }
      if (error instanceof v.ValiError) {
        return Response.json(
          { error: error.issues.map((issue) => issue.message).join('; ') },
          { status: 400 }
        );
      }
      if (error instanceof UnknownQueueError) {
        return Response.json({ error: error.message }, { status: 404 });
      }
      // An error thrown inside a Durable Object keeps its name, not its class.
      if (error instanceof Error && error.name === 'UnknownTargetError') {
        return Response.json({ error: error.message }, { status: 404 });
      }
      if (error instanceof Error && error.name === 'QueueError') {
        return Response.json({ error: error.message }, { status: 409 });
      }
      console.error({ event: 'fifo_queue.request.failed', error });
      return Response.json({ error: 'Internal error' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
