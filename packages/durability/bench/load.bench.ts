// Scenarios are generated from a table, so titles are variables and assertions
// live in each scenario's `expect` callback.
/* eslint-disable vitest/valid-title, vitest/expect-expect */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { LoadReport, LoadTestObject } from './load-worker';

declare global {
  namespace Cloudflare {
    interface Env {
      LOAD_TEST: DurableObjectNamespace<LoadTestObject>;
    }
  }
}

// The shared concurrency budget configured on the bench scheduler.
const ALARM_CONCURRENCY = 10;

type Scenario = {
  name: string;
  params: {
    count: number;
    failUntil?: number;
    holdMs?: number;
    fillerBytes?: number;
    alarmCount?: number;
    drainTimeoutMs?: number;
  };
  expect: (report: LoadReport, params: Scenario['params']) => void;
};

const emit = (name: string, params: unknown, report: LoadReport): void => {
  console.log(
    `BENCH ${JSON.stringify({
      scenario: name,
      compatibilityDate: '2026-07-07',
      alarmConcurrency: ALARM_CONCURRENCY,
      params,
      report,
    })}`
  );
};

const scenarios: Scenario[] = [
  {
    name: 'backlog-drain-100',
    params: { count: 100 },
    expect: (report, params) => {
      expect(report.completed).toBe(params.count);
      expect(report.failed).toBe(0);
      expect(report.pendingAtDeadline).toBe(0);
      expect(report.operationAttempts).toBe(params.count);
    },
  },
  {
    name: 'backlog-drain-1000',
    params: { count: 1_000 },
    expect: (report, params) => {
      expect(report.completed).toBe(params.count);
      expect(report.failed).toBe(0);
      expect(report.pendingAtDeadline).toBe(0);
    },
  },
  {
    name: 'backlog-drain-10000',
    params: { count: 10_000, drainTimeoutMs: 300_000 },
    expect: (report, params) => {
      expect(report.completed).toBe(params.count);
      expect(report.failed).toBe(0);
      expect(report.pendingAtDeadline).toBe(0);
    },
  },
  {
    name: 'retry-storm-zero-delay',
    params: { count: 500, failUntil: 3 },
    expect: (report, params) => {
      expect(report.completed).toBe(params.count);
      expect(report.failed).toBe(0);
      expect(report.pendingAtDeadline).toBe(0);
      // Three forced failures plus one success per operation.
      expect(report.operationAttempts).toBe(params.count * 4);
    },
  },
  {
    name: 'mixed-operations-and-alarm',
    params: { count: 200, holdMs: 20, alarmCount: 1 },
    expect: (report) => {
      expect(report.completed).toBe(200);
      expect(report.failed).toBe(0);
      expect(report.pendingAtDeadline).toBe(0);
      // One shared budget: overlapping operations and the alarm never exceed it.
      expect(report.maxConcurrent).toBeLessThanOrEqual(ALARM_CONCURRENCY);
      expect(report.maxConcurrent).toBeGreaterThan(1);
    },
  },
  {
    name: 'large-payload-growth',
    params: { count: 1_000, fillerBytes: 1_024 },
    expect: (report, params) => {
      expect(report.completed).toBe(params.count);
      expect(report.callRows).toBe(params.count);
    },
  },
];

describe('durability load characterization', () => {
  for (const scenario of scenarios) {
    it(
      scenario.name,
      async () => {
        const stub = env.LOAD_TEST.get(env.LOAD_TEST.newUniqueId());
        const report = await stub.run(scenario.params);
        emit(scenario.name, scenario.params, report);
        scenario.expect(report, scenario.params);
      },
      scenario.params.drainTimeoutMs
        ? scenario.params.drainTimeoutMs + 60_000
        : 120_000
    );
  }
});
