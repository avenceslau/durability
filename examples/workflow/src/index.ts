import { DurableObject } from 'cloudflare:workers';
import { createWorkflow } from 'durability/workflow';
import { ms } from 'itty-time';

type ReportRequest = {
  id: string;
};

type ReportResult = {
  id: string;
  preparedAt: number;
  startedAt: number;
};

export class ReportWorkflow extends DurableObject<Cloudflare.Env> {
  private readonly workflow = createWorkflow<ReportRequest, ReportResult>(
    this.ctx,
    async (event, step) => {
      const [startedAt, preparedAt] = await Promise.all([
        step.do(
          'record start',
          {
            retries: {
              limit: 3,
              delay: ms('1 second'),
              backoff: 'exponential',
            },
            timeout: ms('30 seconds'),
          },
          async ({ attempt }) => {
            const timestamp = Date.now();
            await this.ctx.storage.put('startedAt', { attempt, timestamp });
            return timestamp;
          }
        ),
        step.do('prepare report', async () => {
          const timestamp = Date.now();
          await this.ctx.storage.put('preparedAt', timestamp);
          return timestamp;
        }),
      ]);

      await step.sleep('wait before finishing', ms('2 seconds'));

      return step.do('finish report', async () => {
        await this.ctx.storage.put('finished', true);
        return { id: event.payload.id, preparedAt, startedAt };
      });
    }
  );

  start(request: ReportRequest) {
    return this.workflow.start(request);
  }

  status() {
    return this.workflow.status();
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.workflow.alarm(info);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const id = new URL(request.url).pathname.slice(1);
    if (!id) {
      return new Response('Use /<report-id>', { status: 400 });
    }

    const workflow = env.REPORT_WORKFLOW.getByName(id);
    if (request.method === 'POST') {
      await workflow.start({ id });
      return Response.json({ id }, { status: 202 });
    }
    if (request.method === 'GET') {
      return Response.json(await workflow.status());
    }
    return new Response('Method not allowed', { status: 405 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
