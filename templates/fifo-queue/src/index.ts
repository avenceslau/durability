import { WorkerEntrypoint, env } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  queueNameSchema,
  sendSchema,
  settingsInputSchema,
  targetInputSchema,
  targetNameSchema,
  type MessageInput,
} from './model';
import { directory, orchestrators } from './namespaces';
import { redrive, UnknownTargetError, type RedriveOutcome } from './redrive';
import { send, UnknownQueueError, type SendOutcome } from './send';

export { Directory } from './directory';
export { Limiter } from './limiter';
export { Orchestrator } from './orchestrator';
export { Partition } from './partition';

/**
 * For other Workers: bind this entrypoint as a service and call it directly,
 * without a token or an HTTP round trip.
 */
export class QueueBinding extends WorkerEntrypoint<Cloudflare.Env> {
  send(queue: string, messages: MessageInput[]): Promise<SendOutcome> {
    return send(queue, v.parse(sendSchema, messages));
  }

  /** Replays every dead letter of the queue, or only those of one target. */
  redrive(queue: string, target?: string): Promise<RedriveOutcome> {
    return redrive(
      v.parse(queueNameSchema, queue),
      target === undefined ? undefined : v.parse(targetNameSchema, target)
    );
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const sessionCookie = 'fifo_queue_session';

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

const sessionValue = async (): Promise<string> =>
  [...new Uint8Array(await digest(`session:${env.ADMIN_TOKEN}`))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const bearer = (request: Request): string | undefined =>
  request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];

const cookie = (request: Request, name: string): string | undefined =>
  request.headers
    .get('Cookie')
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];

/**
 * The dashboard signs in once and then carries a cookie, which a WebSocket
 * sends too. A browser attaches that cookie to requests from other pages of
 * the same site, so a cookie only counts when the request comes from this
 * origin: every browser states the origin on a WebSocket and on anything but
 * a plain read.
 */
const isAdmin = async (request: Request): Promise<boolean> => {
  const token = bearer(request);
  if (token !== undefined) {
    return matches(token, env.ADMIN_TOKEN);
  }

  const session = cookie(request, sessionCookie);
  if (
    session === undefined ||
    !(await matches(session, await sessionValue()))
  ) {
    return false;
  }
  const plainRead =
    (request.method === 'GET' || request.method === 'HEAD') &&
    request.headers.get('Upgrade') === null;
  return (
    plainRead || request.headers.get('Origin') === new URL(request.url).origin
  );
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

const signIn = async (request: Request): Promise<Response> => {
  const { token } = await parse(v.object({ token: v.string() }), request);
  if (!(await matches(token, env.ADMIN_TOKEN))) {
    throw new HttpError(401, 'Wrong token');
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Set-Cookie': `${sessionCookie}=${await sessionValue()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
    },
  });
};

const queues = async (request: Request): Promise<Response> => {
  if (request.method === 'GET') {
    return Response.json(await directory().list());
  }
  if (request.method !== 'POST') {
    throw new HttpError(405, 'Method not allowed');
  }

  const input = await parse(
    v.object({
      name: queueNameSchema,
      settings: v.optional(settingsInputSchema, {}),
    }),
    request
  );
  await orchestrators()
    .getByName(input.name)
    .create(input.name, input.settings);
  await directory().add(input.name);
  return Response.json({ name: input.name }, { status: 201 });
};

const queue = async (
  request: Request,
  queueName: string,
  rest: string[]
): Promise<Response> => {
  const orchestrator = orchestrators().getByName(queueName);
  const [resource, targetSegment, action] = rest;

  if (resource === undefined) {
    if (request.method === 'GET') {
      return Response.json(await orchestrator.overview());
    }
    if (request.method === 'PATCH') {
      const { settings } = await orchestrator.overview();
      const patch = await parse(v.record(v.string(), v.unknown()), request);
      await orchestrator.updateSettings(
        v.parse(settingsInputSchema, {
          ...settings,
          ...patch,
          partitions: {
            ...settings.partitions,
            ...(patch['partitions'] as object | undefined),
          },
        })
      );
      return new Response(null, { status: 204 });
    }
    if (request.method === 'DELETE') {
      await orchestrator.delete();
      await directory().remove(queueName);
      return new Response(null, { status: 204 });
    }
  }

  if (resource === 'socket') {
    return orchestrator.fetch(request);
  }
  if (resource === 'messages' && request.method === 'POST') {
    return accept(queueName, request);
  }
  if (resource === 'redrive' && request.method === 'POST') {
    return Response.json(await redrive(queueName));
  }
  if (resource === 'resize' && request.method === 'POST') {
    const { partitions } = await parse(
      v.object({
        partitions: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
      }),
      request
    );
    await orchestrator.resize(partitions);
    return new Response(null, { status: 204 });
  }

  if (resource !== 'targets' || targetSegment === undefined) {
    throw new HttpError(404, 'Not found');
  }
  const target = name(targetNameSchema, targetSegment);

  if (action === undefined && request.method === 'PUT') {
    await orchestrator.putTarget(
      target,
      await parse(targetInputSchema, request)
    );
    return new Response(null, { status: 204 });
  }
  if (action === undefined && request.method === 'DELETE') {
    await orchestrator.removeTarget(target);
    return new Response(null, { status: 204 });
  }
  if (action === 'pause' && request.method === 'POST') {
    const { paused } = await parse(v.object({ paused: v.boolean() }), request);
    await orchestrator.pauseTarget(target, paused);
    return new Response(null, { status: 204 });
  }
  if (action === 'redrive' && request.method === 'POST') {
    return Response.json(await redrive(queueName, target));
  }
  throw new HttpError(404, 'Not found');
};

const route = async (request: Request): Promise<Response> => {
  const [root, ...segments] = new URL(request.url).pathname
    .split('/')
    .filter((segment) => segment.length > 0);

  if (root === 'queues') {
    const [queueSegment, resource] = segments;
    if (resource !== 'messages' || request.method !== 'POST') {
      throw new HttpError(404, 'Not found');
    }
    const token = bearer(request);
    if (token === undefined || !(await matches(token, env.PRODUCER_TOKEN))) {
      throw new HttpError(401, 'A producer token is required');
    }
    return accept(name(queueNameSchema, queueSegment), request);
  }

  if (root !== 'api') {
    throw new HttpError(404, 'Not found');
  }
  const [resource, queueSegment, ...rest] = segments;
  if (resource === 'session' && request.method === 'POST') {
    return signIn(request);
  }
  if (!(await isAdmin(request))) {
    throw new HttpError(401, 'An admin token is required');
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
      if (
        error instanceof UnknownQueueError ||
        error instanceof UnknownTargetError
      ) {
        return Response.json({ error: error.message }, { status: 404 });
      }
      // An error thrown inside a Durable Object keeps its name, not its class.
      if (error instanceof Error && error.name === 'QueueError') {
        return Response.json({ error: error.message }, { status: 409 });
      }
      console.error({ event: 'fifo_queue.request.failed', error });
      return Response.json({ error: 'Internal error' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
