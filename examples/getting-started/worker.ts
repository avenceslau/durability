import { DurableObject } from 'cloudflare:workers';
import { Durability, type DurableCall } from 'durability';

type Env = {
  JOBS: DurableObjectNamespace<Jobs>;
};

type CountWords = { text: string };

export class Jobs extends DurableObject<Env> {
  private readonly jobs = new Durability({
    context: this.ctx,
    handlers: {
      countWords: async ({ payload }: DurableCall<CountWords>) => ({
        words: payload.text.trim().split(/\s+/u).filter(Boolean).length,
      }),
    },
  });

  submit(id: string, text: string) {
    return this.jobs.countWords({ id, payload: { text } });
  }

  result(id: string) {
    return this.jobs.countWords.getResult(id);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.jobs.alarm(info);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/jobs\/([^/]+)$/u.exec(new URL(request.url).pathname);
    if (!match) {
      return new Response('Use POST or GET /jobs/:id', { status: 404 });
    }
    const id = match[1]!;
    // One object keeps the demo simple; choose object names for your workload.
    const jobs = env.JOBS.getByName('demo');

    if (request.method === 'POST') {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response('Expected JSON', { status: 400 });
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        !('text' in body) ||
        typeof body.text !== 'string'
      ) {
        return new Response('Expected { "text": string }', { status: 400 });
      }
      try {
        await jobs.submit(id, body.text);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === 'DuplicateDurableCallError' ||
            error.name === 'DuplicateDurablePayloadError')
        ) {
          return Response.json({ error: error.message }, { status: 409 });
        }
        throw error;
      }
      return Response.json({ id }, { status: 202 });
    }

    if (request.method === 'GET') {
      return Response.json(await jobs.result(id));
    }

    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, POST' },
    });
  },
} satisfies ExportedHandler<Env>;
