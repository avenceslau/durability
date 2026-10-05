/**
 * `Durability` example: effectively-once operations with idempotency keys.
 *
 * A resize request is registered durably and survives eviction, restarts, and
 * transient API failures. The same idempotency key never runs the resize
 * twice, and the persisted result is read back with `getResult`.
 */
import { DurableObject } from 'cloudflare:workers';
import { Durability, NonRetryableError, type DurableCall } from 'durability';

type Env = {
  IMAGE_JOBS: DurableObjectNamespace<ImageJobs>;
  /** Upstream image service; resize calls must be idempotent. */
  IMAGE_API: Fetcher;
};

type ResizeInput = { imageId: string; width: number };
type ResizeOutput = { url: string };

export class ImageJobs extends DurableObject<Env> {
  private readonly durability = new Durability({
    context: this.ctx,
    handlers: {
      resizeImage: async ({
        id,
        payload,
        signal,
      }: DurableCall<ResizeInput>): Promise<ResizeOutput> => {
        // Permanent input problems should not burn retry attempts.
        if (!Number.isInteger(payload.width) || payload.width <= 0) {
          throw new NonRetryableError(`Invalid width ${payload.width}`);
        }

        // The idempotency key lets the upstream service deduplicate a retry
        // whose previous attempt succeeded after we stopped waiting.
        const response = await this.env.IMAGE_API.fetch(
          'https://image-api/resize',
          {
            method: 'POST',
            headers: { 'Idempotency-Key': id },
            body: JSON.stringify(payload),
            signal,
          }
        );
        if (!response.ok) {
          throw new Error(`Resize failed with ${response.status}`);
        }
        return response.json();
      },
    },
    attemptTimeoutMs: 60_000,
    retries: { maxAttempts: 5 },
  });

  /** Resolves once the job is durably registered, not when it completes. */
  resize(imageId: string, width: number) {
    return this.durability.resizeImage({
      id: `resize:${imageId}:${width}`,
      payload: { imageId, width },
    });
  }

  result(imageId: string, width: number) {
    return this.durability.resizeImage.getResult(`resize:${imageId}:${width}`);
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const [, imageId, action] = url.pathname.split('/');
    if (!imageId || !action) {
      return new Response('Expected /:imageId/resize or /:imageId/result', {
        status: 404,
      });
    }
    const width = Number(url.searchParams.get('width') ?? 512);
    const jobs = env.IMAGE_JOBS.getByName(imageId);

    if (request.method === 'POST' && action === 'resize') {
      await jobs.resize(imageId, width);
      return new Response('registered', { status: 202 });
    }
    if (action === 'result') {
      return Response.json(await jobs.result(imageId, width));
    }
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
