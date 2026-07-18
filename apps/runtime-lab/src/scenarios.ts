export const scenarioIds = [
  'happy-path',
  'transient-before-effect',
  'downstream-unavailable',
  'after-effect-idempotent',
  'after-effect-unprotected',
  'crash-before-effect',
  'crash-after-effect-idempotent',
  'crash-after-effect-unprotected',
  'timeout-then-success',
  'timeout-ignores-abort',
  'non-retryable',
  'retry-exhaustion',
  'duplicate-submission',
  'operation-id-collision',
  'named-alarm-retry',
  'named-alarm-replacement',
  'concurrency-burst',
] as const;

export type ScenarioId = (typeof scenarioIds)[number];

export type ScenarioGroup =
  | 'baseline'
  | 'crash'
  | 'delivery boundary'
  | 'retry policy'
  | 'alarm semantics'
  | 'concurrency';

export type StartKind =
  | 'operation'
  | 'timeout'
  | 'duplicate'
  | 'collision'
  | 'named-alarm'
  | 'named-alarm-replacement'
  | 'burst';

export type ScenarioDefinition = {
  id: ScenarioId;
  title: string;
  group: ScenarioGroup;
  summary: string;
  proves: string;
  startKind: StartKind;
  expectedOutcome: string;
  settleMs: number;
  riskDemonstration?: boolean;
};

export const scenarios: Record<ScenarioId, ScenarioDefinition> = {
  'happy-path': {
    id: 'happy-path',
    title: 'Happy path',
    group: 'baseline',
    summary:
      'Register, execute, persist the result, and apply one side effect.',
    proves: 'The complete operation lifecycle works in a real Workers runtime.',
    startKind: 'operation',
    expectedOutcome: 'completed once; one committed effect',
    settleMs: 0,
  },
  'transient-before-effect': {
    id: 'transient-before-effect',
    title: 'Transient handler failure',
    group: 'retry policy',
    summary:
      'Throw twice before touching the downstream service, then recover.',
    proves: 'Pending state and retry attempts survive alarm-driven execution.',
    startKind: 'operation',
    expectedOutcome: 'completed on attempt 3; one committed effect',
    settleMs: 0,
  },
  'downstream-unavailable': {
    id: 'downstream-unavailable',
    title: 'Downstream service unavailable',
    group: 'retry policy',
    summary:
      'The downstream Durable Object throws before committing twice, then recovers.',
    proves:
      'Remote RPC failures are persisted and retried without phantom effects.',
    startKind: 'operation',
    expectedOutcome: 'completed on attempt 3; one committed effect',
    settleMs: 0,
  },
  'after-effect-idempotent': {
    id: 'after-effect-idempotent',
    title: 'Failure after an idempotent effect',
    group: 'delivery boundary',
    summary:
      'The downstream service commits, then reports failure twice while deduplicating by call ID.',
    proves:
      'Stable idempotency keys turn at-least-once attempts into one externally visible effect.',
    startKind: 'operation',
    expectedOutcome: '3 delivery attempts; exactly one committed effect',
    settleMs: 0,
  },
  'after-effect-unprotected': {
    id: 'after-effect-unprotected',
    title: 'Failure after an unprotected effect',
    group: 'delivery boundary',
    summary:
      'The downstream service commits, then reports failure twice without deduplication.',
    proves:
      'Durability cannot manufacture exactly-once semantics for an arbitrary external side effect.',
    startKind: 'operation',
    expectedOutcome:
      '3 delivery attempts; 3 committed effects (intentional warning)',
    settleMs: 0,
    riskDemonstration: true,
  },
  'crash-before-effect': {
    id: 'crash-before-effect',
    title: 'Object crash before side effect',
    group: 'crash',
    summary:
      'Force DurableObjectState.abort() on the first attempt before downstream I/O.',
    proves:
      'The committed registration is recovered by a fresh object instance and its alarm.',
    startKind: 'operation',
    expectedOutcome: 'completed on attempt 2; one committed effect',
    settleMs: 0,
  },
  'crash-after-effect-idempotent': {
    id: 'crash-after-effect-idempotent',
    title: 'Crash after an idempotent effect',
    group: 'crash',
    summary:
      'Commit downstream, abruptly reset the job object, and retry with the same key.',
    proves:
      'The hardest uncertainty window is safe when the receiver deduplicates.',
    startKind: 'operation',
    expectedOutcome: '2 delivery attempts; exactly one committed effect',
    settleMs: 0,
  },
  'crash-after-effect-unprotected': {
    id: 'crash-after-effect-unprotected',
    title: 'Crash after an unprotected effect',
    group: 'crash',
    summary:
      'Commit downstream, abruptly reset the job object, and retry without deduplication.',
    proves:
      'A crash between effect and completion persistence produces a duplicate without receiver protection.',
    startKind: 'operation',
    expectedOutcome:
      '2 delivery attempts; 2 committed effects (intentional warning)',
    settleMs: 0,
    riskDemonstration: true,
  },
  'timeout-then-success': {
    id: 'timeout-then-success',
    title: 'Abort-aware timeout',
    group: 'retry policy',
    summary:
      'The first attempt exceeds its deadline and honors AbortSignal; the retry succeeds quickly.',
    proves: 'Timeout state is persisted and the next alarm can safely resume.',
    startKind: 'timeout',
    expectedOutcome: 'completed on attempt 2; one committed effect',
    settleMs: 0,
  },
  'timeout-ignores-abort': {
    id: 'timeout-ignores-abort',
    title: 'Handler ignores AbortSignal',
    group: 'delivery boundary',
    summary:
      'The first timed-out handler keeps running while a later attempt succeeds.',
    proves:
      'Late work can overlap retries; receiver idempotency is still required after timeouts.',
    startKind: 'timeout',
    expectedOutcome: 'overlapping attempts; one deduplicated committed effect',
    settleMs: 350,
  },
  'non-retryable': {
    id: 'non-retryable',
    title: 'Permanent failure',
    group: 'retry policy',
    summary: 'Throw NonRetryableError on the first attempt.',
    proves: 'Permanent failures become terminal without wasting retry budget.',
    startKind: 'operation',
    expectedOutcome: 'failed after one attempt; no effect',
    settleMs: 0,
  },
  'retry-exhaustion': {
    id: 'retry-exhaustion',
    title: 'Retry exhaustion',
    group: 'retry policy',
    summary: 'Fail every attempt until the configured budget is exhausted.',
    proves:
      'The operation reaches a durable terminal failure with complete evidence.',
    startKind: 'operation',
    expectedOutcome: 'failed after 5 attempts; no effect',
    settleMs: 0,
  },
  'duplicate-submission': {
    id: 'duplicate-submission',
    title: 'Duplicate concurrent submissions',
    group: 'concurrency',
    summary: 'Submit the same call ID twenty times concurrently.',
    proves:
      'Registration and in-memory execution deduplication produce one effect.',
    startKind: 'duplicate',
    expectedOutcome: 'one call record; one committed effect',
    settleMs: 0,
  },
  'operation-id-collision': {
    id: 'operation-id-collision',
    title: 'Call ID reused by another operation',
    group: 'concurrency',
    summary:
      'Register one operation, then reuse its ID for a differently typed operation.',
    proves:
      'The package rejects cross-operation ID reuse instead of returning a mistyped result.',
    startKind: 'collision',
    expectedOutcome:
      'DuplicateDurableCallError observed; original call completes',
    settleMs: 0,
  },
  'named-alarm-retry': {
    id: 'named-alarm-retry',
    title: 'Named alarm retry',
    group: 'alarm semantics',
    summary:
      'A logical alarm fails once and succeeds on its next scheduled attempt.',
    proves:
      'Named alarm occurrence identity and idempotency key survive retry.',
    startKind: 'named-alarm',
    expectedOutcome: '2 attempts; one committed effect with one stable key',
    settleMs: 0,
  },
  'named-alarm-replacement': {
    id: 'named-alarm-replacement',
    title: 'Named alarm replacement',
    group: 'alarm semantics',
    summary: 'Schedule the same logical alarm twice before it fires.',
    proves: 'Only the replacement occurrence executes.',
    startKind: 'named-alarm-replacement',
    expectedOutcome: 'one alarm attempt for the replacement occurrence',
    settleMs: 0,
  },
  'concurrency-burst': {
    id: 'concurrency-burst',
    title: 'Concurrent retry burst',
    group: 'concurrency',
    summary:
      'Register twelve calls that fail once, then become due together on the same object.',
    proves:
      'Alarm batching, bounded concurrency, and per-call persistence hold under interleaving.',
    startKind: 'burst',
    expectedOutcome:
      '12 completed calls; 12 committed effects; overlapping handlers observed',
    settleMs: 0,
  },
};

export const isScenarioId = (value: string): value is ScenarioId =>
  Object.prototype.hasOwnProperty.call(scenarios, value);

export type CallState = {
  id: string;
  operation: string;
  status: 'pending' | 'completed' | 'failed';
  attempt: number;
  nextAttemptAt: number;
  lastError: string | null;
  lastErrorName: string | null;
};

export type AlarmState = {
  name: string;
  generationId: string;
  status: 'pending' | 'failed';
  scheduledAt: number;
  nextAttemptAt: number;
  attempt: number;
  lastError: string | null;
  lastErrorName: string | null;
};

export type LabEvent = {
  sequence: number;
  kind: string;
  callId: string | null;
  attempt: number | null;
  detail: string;
  at: number;
};

export type EffectAttempt = {
  sequence: number;
  callId: string;
  jobAttempt: number;
  idempotencyKey: string;
  mode: string;
  applied: boolean;
  at: number;
};

export type EffectCommit = {
  commitKey: string;
  callId: string;
  jobAttempt: number;
  idempotencyKey: string;
  value: string;
  at: number;
};

export type LabSnapshot = {
  runId: string;
  scenario: ScenarioId;
  calls: CallState[];
  alarms: AlarmState[];
  physicalAlarmAt: number | null;
  events: LabEvent[];
  maxActiveHandlers: number;
  collisionError: string | null;
};

export type EffectSnapshot = {
  runId: string;
  attempts: EffectAttempt[];
  commits: EffectCommit[];
};

export type Check = {
  label: string;
  pass: boolean;
  actual: string;
};

export type RunVerdict = {
  state: 'running' | 'passed' | 'warning-demonstrated' | 'failed';
  checks: Check[];
};

const check = (label: string, pass: boolean, actual: string): Check => ({
  label,
  pass,
  actual,
});

const callCount = (
  snapshot: LabSnapshot,
  status: CallState['status']
): number => snapshot.calls.filter((call) => call.status === status).length;

export const evaluateRun = (
  lab: LabSnapshot,
  effects: EffectSnapshot
): RunVerdict => {
  const definition = scenarios[lab.scenario];
  const primary = lab.calls.find((call) => call.id === lab.runId);
  let checks: Check[];

  switch (lab.scenario) {
    case 'happy-path':
      checks = [
        check(
          'operation completed',
          primary?.status === 'completed',
          primary?.status ?? 'missing'
        ),
        check(
          'one attempt',
          primary?.attempt === 1,
          String(primary?.attempt ?? 0)
        ),
        check(
          'one external effect',
          effects.commits.length === 1,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'transient-before-effect':
    case 'downstream-unavailable':
      checks = [
        check(
          'operation recovered',
          primary?.status === 'completed',
          primary?.status ?? 'missing'
        ),
        check(
          'completed on attempt 3',
          primary?.attempt === 3,
          String(primary?.attempt ?? 0)
        ),
        check(
          'one external effect',
          effects.commits.length === 1,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'after-effect-idempotent':
      checks = [
        check(
          'operation recovered',
          primary?.status === 'completed',
          primary?.status ?? 'missing'
        ),
        check(
          'three downstream deliveries',
          effects.attempts.length === 3,
          String(effects.attempts.length)
        ),
        check(
          'effect deduplicated',
          effects.commits.length === 1,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'after-effect-unprotected':
      checks = [
        check(
          'operation recovered',
          primary?.status === 'completed',
          primary?.status ?? 'missing'
        ),
        check(
          'three downstream deliveries',
          effects.attempts.length === 3,
          String(effects.attempts.length)
        ),
        check(
          'duplicate risk reproduced',
          effects.commits.length === 3,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'crash-before-effect':
      checks = [
        check(
          'registration survived reset',
          primary?.status === 'completed',
          primary?.status ?? 'missing'
        ),
        check(
          'fresh instance retried',
          (primary?.attempt ?? 0) >= 2,
          String(primary?.attempt ?? 0)
        ),
        check(
          'one external effect',
          effects.commits.length === 1,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'crash-after-effect-idempotent':
      checks = [
        check(
          'operation recovered after reset',
          primary?.status === 'completed',
          primary?.status ?? 'missing'
        ),
        check(
          'downstream saw a retry',
          effects.attempts.length >= 2,
          String(effects.attempts.length)
        ),
        check(
          'effect deduplicated',
          effects.commits.length === 1,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'crash-after-effect-unprotected':
      checks = [
        check(
          'operation recovered after reset',
          primary?.status === 'completed',
          primary?.status ?? 'missing'
        ),
        check(
          'downstream saw a retry',
          effects.attempts.length >= 2,
          String(effects.attempts.length)
        ),
        check(
          'duplicate risk reproduced',
          effects.commits.length >= 2,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'timeout-then-success':
      checks = [
        check(
          'operation recovered',
          primary?.status === 'completed',
          primary?.status ?? 'missing'
        ),
        check(
          'completed on attempt 2',
          primary?.attempt === 2,
          String(primary?.attempt ?? 0)
        ),
        check(
          'one external effect',
          effects.commits.length === 1,
          String(effects.commits.length)
        ),
        check(
          'timeout was persisted',
          lab.events.some((event) => event.kind === 'handler_aborted'),
          lab.events.some((event) => event.kind === 'handler_aborted')
            ? 'observed'
            : 'not yet'
        ),
      ];
      break;
    case 'timeout-ignores-abort':
      checks = [
        check(
          'operation recovered',
          primary?.status === 'completed',
          primary?.status ?? 'missing'
        ),
        check(
          'two handlers reached downstream',
          effects.attempts.length >= 2,
          String(effects.attempts.length)
        ),
        check(
          'late effect deduplicated',
          effects.commits.length === 1,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'non-retryable':
      checks = [
        check(
          'operation terminal',
          primary?.status === 'failed',
          primary?.status ?? 'missing'
        ),
        check(
          'stopped after one attempt',
          primary?.attempt === 1,
          String(primary?.attempt ?? 0)
        ),
        check(
          'no external effect',
          effects.commits.length === 0,
          String(effects.commits.length)
        ),
        check(
          'correct error type',
          primary?.lastErrorName === 'NonRetryableError',
          primary?.lastErrorName ?? 'missing'
        ),
      ];
      break;
    case 'retry-exhaustion':
      checks = [
        check(
          'operation terminal',
          primary?.status === 'failed',
          primary?.status ?? 'missing'
        ),
        check(
          'used all five attempts',
          primary?.attempt === 5,
          String(primary?.attempt ?? 0)
        ),
        check(
          'no external effect',
          effects.commits.length === 0,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'duplicate-submission':
      checks = [
        check(
          'one call record',
          lab.calls.length === 1,
          String(lab.calls.length)
        ),
        check(
          'operation completed',
          primary?.status === 'completed',
          primary?.status ?? 'missing'
        ),
        check(
          'one external effect',
          effects.commits.length === 1,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'operation-id-collision':
      checks = [
        check(
          'original operation completed',
          primary?.status === 'completed',
          primary?.status ?? 'missing'
        ),
        check(
          'collision rejected',
          lab.collisionError?.includes('DuplicateDurableCallError') === true,
          lab.collisionError ?? 'not observed'
        ),
        check(
          'one external effect',
          effects.commits.length === 1,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'named-alarm-retry':
      checks = [
        check(
          'named alarm cleared after success',
          lab.alarms.length === 0,
          String(lab.alarms.length)
        ),
        check(
          'two downstream deliveries',
          effects.attempts.length === 2,
          String(effects.attempts.length)
        ),
        check(
          'effect deduplicated',
          effects.commits.length === 1,
          String(effects.commits.length)
        ),
        check(
          'stable idempotency key',
          new Set(effects.attempts.map((attempt) => attempt.idempotencyKey))
            .size === 1,
          String(
            new Set(effects.attempts.map((attempt) => attempt.idempotencyKey))
              .size
          )
        ),
      ];
      break;
    case 'named-alarm-replacement':
      checks = [
        check(
          'named alarm cleared after success',
          lab.alarms.length === 0,
          String(lab.alarms.length)
        ),
        check(
          'only replacement executed',
          effects.attempts.length === 1,
          String(effects.attempts.length)
        ),
        check(
          'one external effect',
          effects.commits.length === 1,
          String(effects.commits.length)
        ),
      ];
      break;
    case 'concurrency-burst':
      checks = [
        check(
          'all 12 calls completed',
          callCount(lab, 'completed') === 12,
          String(callCount(lab, 'completed'))
        ),
        check(
          '12 external effects',
          effects.commits.length === 12,
          String(effects.commits.length)
        ),
        check(
          'handlers overlapped',
          lab.maxActiveHandlers > 1,
          String(lab.maxActiveHandlers)
        ),
      ];
      break;
  }

  const complete = checks.every((item) => item.pass);
  const terminalFailure =
    lab.calls.some((call) => call.status === 'failed') &&
    lab.scenario !== 'non-retryable' &&
    lab.scenario !== 'retry-exhaustion';
  const state = complete
    ? definition.riskDemonstration
      ? 'warning-demonstrated'
      : 'passed'
    : terminalFailure
      ? 'failed'
      : 'running';

  return { state, checks };
};
