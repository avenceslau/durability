import { dashboardHtml } from './dashboard';
import { DurabilityLab, EffectLedger } from './durable-objects';
import {
  evaluateRun,
  isScenarioId,
  scenarios,
  type ScenarioDefinition,
  type ScenarioId,
} from './scenarios';

export { DurabilityLab, EffectLedger };

type StartRequest = {
  scenario: ScenarioId;
};

const json = (value: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return Response.json(value, { ...init, headers });
};

const parseStartRequest = async (request: Request): Promise<StartRequest> => {
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (contentLength > 16_384) {
    throw new RangeError('Request body is too large');
  }
  const value: unknown = await request.json();
  if (
    typeof value !== 'object' ||
    value === null ||
    !('scenario' in value) ||
    typeof value.scenario !== 'string' ||
    !isScenarioId(value.scenario)
  ) {
    throw new TypeError('Body must contain a valid scenario ID');
  }
  return { scenario: value.scenario };
};

const getRun = async (env: Env, runId: string) => {
  const lab = await env.LAB.getByName(runId).snapshot(runId);
  const effects = await env.EFFECTS.getByName(runId).snapshot(runId);
  return {
    runId,
    definition: scenarios[lab.scenario],
    lab,
    effects,
    verdict: evaluateRun(lab, effects),
    observedAt: Date.now(),
  };
};

const startRun = async (
  env: Env,
  runId: string,
  definition: ScenarioDefinition
): Promise<void> => {
  const lab = env.LAB.getByName(runId);
  switch (definition.startKind) {
    case 'operation':
    case 'timeout':
      await lab.start(runId, definition.id);
      return;
    case 'duplicate':
      await lab.startDuplicate(runId);
      return;
    case 'collision':
      await lab.startCollision(runId);
      return;
    case 'named-alarm':
      await lab.startNamedAlarm(runId, false);
      return;
    case 'named-alarm-replacement':
      await lab.startNamedAlarm(runId, true);
      return;
    case 'burst':
      await lab.startBurst(runId);
      return;
  }
};

const route = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/') {
    return new Response(dashboardHtml, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/scenarios') {
    return json(Object.values(scenarios));
  }

  if (request.method === 'POST' && url.pathname === '/api/runs') {
    const { scenario } = await parseStartRequest(request);
    const definition = scenarios[scenario];
    const runId = `${scenario}:${crypto.randomUUID()}`;
    try {
      await startRun(env, runId, definition);
    } catch (error) {
      const resetScenario =
        scenario === 'crash-before-effect' ||
        scenario === 'crash-after-effect-idempotent' ||
        scenario === 'crash-after-effect-unprotected';
      if (!resetScenario) {
        throw error;
      }
      console.warn(
        JSON.stringify({
          message: 'Expected injected reset reached the Worker caller',
          scenario,
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }

    let run;
    try {
      run = await getRun(env, runId);
    } catch {
      run = {
        runId,
        definition,
        lab: null,
        effects: null,
        verdict: { state: 'running' as const, checks: [] },
        observedAt: Date.now(),
      };
    }
    return json(run, { status: 202 });
  }

  const match = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === 'GET' && match?.[1]) {
    return json(await getRun(env, decodeURIComponent(match[1])));
  }

  const abortMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/abort$/);
  if (request.method === 'POST' && abortMatch?.[1]) {
    const runId = decodeURIComponent(abortMatch[1]);
    try {
      await env.LAB.getByName(runId).forceAbort();
    } catch {
      // The injected reset is the successful outcome.
    }
    return json({ runId, reset: true }, { status: 202 });
  }

  return json({ error: 'Not found' }, { status: 404 });
};

export default {
  async fetch(request, env): Promise<Response> {
    const startedAt = Date.now();
    try {
      const response = await route(request, env);
      console.log(
        JSON.stringify({
          message: 'runtime-lab-request',
          method: request.method,
          path: new URL(request.url).pathname,
          status: response.status,
          durationMs: Date.now() - startedAt,
        })
      );
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          message: 'runtime-lab-request-failed',
          method: request.method,
          path: new URL(request.url).pathname,
          error: message,
          durationMs: Date.now() - startedAt,
        })
      );
      const status =
        error instanceof TypeError || error instanceof RangeError ? 400 : 500;
      return json({ error: message }, { status });
    }
  },
} satisfies ExportedHandler<Env>;
