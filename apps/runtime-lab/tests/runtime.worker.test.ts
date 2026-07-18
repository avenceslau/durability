import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  SELF,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { RunVerdict, ScenarioId } from '../src/scenarios';

/* eslint-disable no-await-in-loop -- Runtime polling and ordered fault injection must be sequential. */

type RunResponse = {
  runId: string;
  verdict: RunVerdict;
  lab: {
    calls: Array<{
      status: 'pending' | 'completed' | 'failed';
      nextAttemptAt: number;
    }>;
    alarms: Array<{
      status: 'pending' | 'failed';
      nextAttemptAt: number;
    }>;
    physicalAlarmAt: number | null;
  } | null;
};

const start = async (scenario: ScenarioId): Promise<RunResponse> => {
  const response = await SELF.fetch('https://lab.test/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  expect(response.status).toBe(202);
  return response.json<RunResponse>();
};

const read = async (runId: string): Promise<RunResponse | undefined> => {
  const response = await SELF.fetch(
    `https://lab.test/api/runs/${encodeURIComponent(runId)}`
  );
  if (!response.ok) {
    return undefined;
  }
  return response.json<RunResponse>();
};

const settle = async (
  runId: string,
  timeoutMs = 8_000
): Promise<RunResponse> => {
  const deadline = Date.now() + timeoutMs;
  let last: RunResponse | undefined;

  while (Date.now() < deadline) {
    last = await read(runId);
    if (
      last &&
      last.verdict.state !== 'running' &&
      last.verdict.checks.every((item) => item.pass)
    ) {
      return last;
    }

    const pendingAt = [
      ...(last?.lab?.calls ?? [])
        .filter((call) => call.status === 'pending')
        .map((call) => call.nextAttemptAt),
      ...(last?.lab?.alarms ?? [])
        .filter((alarm) => alarm.status === 'pending')
        .map((alarm) => alarm.nextAttemptAt),
      ...(last?.lab?.physicalAlarmAt ? [last.lab.physicalAlarmAt] : []),
    ];
    const nextAt =
      pendingAt.length > 0 ? Math.min(...pendingAt) : Date.now() + 20;
    await scheduler.wait(Math.max(10, Math.min(120, nextAt - Date.now() + 5)));

    try {
      const stub = env.LAB.getByName(runId);
      await runDurableObjectAlarm(stub);
    } catch {
      // Forced resets intentionally break the current stub. The next loop
      // obtains a fresh one, matching production retry guidance.
    }
  }

  throw new Error(
    `Run ${runId} did not settle: ${JSON.stringify(last?.verdict ?? null)}`
  );
};

describe('runtime lab', () => {
  it('serves the dashboard and complete failure matrix', async () => {
    const page = await SELF.fetch('https://lab.test/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Durability Runtime Lab');

    const response = await SELF.fetch('https://lab.test/api/scenarios');
    const definitions = await response.json<Array<{ id: string }>>();
    expect(definitions).toHaveLength(17);
  });

  it.each([
    'happy-path',
    'transient-before-effect',
    'downstream-unavailable',
    'after-effect-idempotent',
    'after-effect-unprotected',
    'timeout-then-success',
    'timeout-ignores-abort',
    'non-retryable',
    'retry-exhaustion',
    'duplicate-submission',
    'operation-id-collision',
    'named-alarm-retry',
    'named-alarm-replacement',
    'concurrency-burst',
  ] satisfies ScenarioId[])(
    '%s satisfies its persisted invariants',
    async (scenario) => {
      const run = await start(scenario);
      const settled = await settle(run.runId);
      expect(settled.verdict.checks.every((item) => item.pass)).toBe(true);
      expect(['passed', 'warning-demonstrated']).toContain(
        settled.verdict.state
      );
    }
  );

  it.each([
    'crash-before-effect',
    'crash-after-effect-idempotent',
    'crash-after-effect-unprotected',
  ] satisfies ScenarioId[])(
    '%s recovers after a forced object reset',
    async (scenario) => {
      const run = await start(scenario);
      const settled = await settle(run.runId, 12_000);
      expect(settled.verdict.checks.every((item) => item.pass)).toBe(true);
      expect(['passed', 'warning-demonstrated']).toContain(
        settled.verdict.state
      );
    }
  );

  it('retains pending work through a graceful eviction', async () => {
    const run = await start('transient-before-effect');
    const stub = env.LAB.getByName(run.runId);

    for (let index = 0; index < 20; index += 1) {
      const snapshot = await read(run.runId);
      if (snapshot?.lab?.calls[0]?.status === 'pending') {
        break;
      }
      await scheduler.wait(10);
    }

    await evictDurableObject(stub);
    const settled = await settle(run.runId);
    expect(settled.verdict.state).toBe('passed');
  });
});
