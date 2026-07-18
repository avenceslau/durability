import { DurableObject } from 'cloudflare:workers';
import {
  createDurability,
  NonRetryableError,
  type DurableAlarmInfo,
  type DurableCall,
} from 'durability';
import type {
  AlarmState,
  CallState,
  EffectAttempt,
  EffectCommit,
  EffectSnapshot,
  LabEvent,
  LabSnapshot,
  ScenarioId,
} from './scenarios';

type OperationPayload = {
  runId: string;
  callId: string;
  scenario: ScenarioId;
};

type EffectInput = {
  runId: string;
  callId: string;
  jobAttempt: number;
  idempotencyKey: string;
  idempotent: boolean;
  mode:
    | 'success'
    | 'throw-before-commit'
    | 'throw-after-commit'
    | 'named-alarm';
  failThroughAttempt: number;
  value: string;
};

type EffectResult = {
  applied: boolean;
  commitKey: string;
};

type RawCallRow = {
  id: string;
  operation: string;
  status: CallState['status'];
  attempt: number;
  next_attempt_at: number;
  last_error: string | null;
  last_error_name: string | null;
};

type RawAlarmRow = {
  name: string;
  generation_id: string;
  status: AlarmState['status'];
  scheduled_at: number;
  next_attempt_at: number;
  attempt: number;
  last_error: string | null;
  last_error_name: string | null;
};

type RawEventRow = {
  sequence: number;
  kind: string;
  call_id: string | null;
  attempt: number | null;
  detail: string;
  at: number;
};

type RawEffectAttempt = {
  sequence: number;
  call_id: string;
  job_attempt: number;
  idempotency_key: string;
  mode: string;
  applied: number;
  at: number;
};

type RawEffectCommit = {
  commit_key: string;
  call_id: string;
  job_attempt: number;
  idempotency_key: string;
  value: string;
  at: number;
};

const waitWithSignal = async (
  durationMs: number,
  signal: AbortSignal
): Promise<void> => {
  if (signal.aborted) {
    throw signal.reason;
  }

  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    await Promise.race([scheduler.wait(durationMs), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

const errorLabel = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export class EffectLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS effect_attempts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        job_attempt INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        mode TEXT NOT NULL,
        applied INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effect_commits (
        commit_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        job_attempt INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        value TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fault_claims (
        fault_key TEXT PRIMARY KEY,
        claims INTEGER NOT NULL
      );
    `);
  }

  claimFault(faultKey: string, limit: number): boolean {
    const row = this.ctx.storage.sql
      .exec<{ claims: number }>(
        `INSERT INTO fault_claims (fault_key, claims)
         VALUES (?, 1)
         ON CONFLICT(fault_key) DO UPDATE SET claims = claims + 1
         RETURNING claims`,
        faultKey
      )
      .one();
    return row.claims <= limit;
  }

  apply(input: EffectInput): EffectResult {
    const shouldFail = input.jobAttempt <= input.failThroughAttempt;
    const now = Date.now();

    if (input.mode === 'throw-before-commit' && shouldFail) {
      this.ctx.storage.sql.exec(
        `INSERT INTO effect_attempts
          (run_id, call_id, job_attempt, idempotency_key, mode, applied, at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
        input.runId,
        input.callId,
        input.jobAttempt,
        input.idempotencyKey,
        input.mode,
        now
      );
      throw new Error(
        `Injected downstream outage on attempt ${input.jobAttempt}`
      );
    }

    const commitKey = input.idempotent
      ? input.idempotencyKey
      : `${input.idempotencyKey}:delivery:${crypto.randomUUID()}`;
    const inserted = this.ctx.storage.sql
      .exec<{ commit_key: string }>(
        `INSERT INTO effect_commits
          (commit_key, run_id, call_id, job_attempt, idempotency_key, value, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(commit_key) DO NOTHING
         RETURNING commit_key`,
        commitKey,
        input.runId,
        input.callId,
        input.jobAttempt,
        input.idempotencyKey,
        input.value,
        now
      )
      .toArray();
    const applied = inserted.length === 1;

    this.ctx.storage.sql.exec(
      `INSERT INTO effect_attempts
        (run_id, call_id, job_attempt, idempotency_key, mode, applied, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.runId,
      input.callId,
      input.jobAttempt,
      input.idempotencyKey,
      input.mode,
      applied ? 1 : 0,
      now
    );

    if (input.mode === 'throw-after-commit' && shouldFail) {
      throw new Error(
        `Injected lost acknowledgement after commit on attempt ${input.jobAttempt}`
      );
    }

    return { applied, commitKey };
  }

  snapshot(runId: string): EffectSnapshot {
    const attempts = this.ctx.storage.sql
      .exec<RawEffectAttempt>(
        `SELECT sequence, call_id, job_attempt, idempotency_key, mode, applied, at
         FROM effect_attempts
         WHERE run_id = ?
         ORDER BY sequence`,
        runId
      )
      .toArray()
      .map(
        (row): EffectAttempt => ({
          sequence: row.sequence,
          callId: row.call_id,
          jobAttempt: row.job_attempt,
          idempotencyKey: row.idempotency_key,
          mode: row.mode,
          applied: row.applied === 1,
          at: row.at,
        })
      );
    const commits = this.ctx.storage.sql
      .exec<RawEffectCommit>(
        `SELECT commit_key, call_id, job_attempt, idempotency_key, value, at
         FROM effect_commits
         WHERE run_id = ?
         ORDER BY at, commit_key`,
        runId
      )
      .toArray()
      .map(
        (row): EffectCommit => ({
          commitKey: row.commit_key,
          callId: row.call_id,
          jobAttempt: row.job_attempt,
          idempotencyKey: row.idempotency_key,
          value: row.value,
          at: row.at,
        })
      );

    return { runId, attempts, commits };
  }
}

export class DurabilityLab extends DurableObject<Env> {
  private activeHandlers = 0;
  private maxActiveHandlers = 0;

  private readonly durability = createDurability(
    this.ctx,
    {
      run: (call: DurableCall<OperationPayload>) => this.executeOperation(call),
      timeoutRun: (call: DurableCall<OperationPayload>) =>
        this.executeOperation(call),
      alternate: async (call: DurableCall<OperationPayload>) => ({
        callId: call.id,
        alternate: true,
      }),
    },
    {
      alarmConcurrency: 4,
      attemptTimeoutMs: 1_000,
      retries: {
        delay: () => 75,
        maxAttempts: 5,
      },
      methods: {
        timeoutRun: {
          attemptTimeoutMs: 100,
          retries: {
            delay: () => 60,
            maxAttempts: 3,
          },
        },
      },
      alarms: {
        probe: (info) => this.executeNamedAlarm(info),
      },
      alarmMethods: {
        probe: {
          attemptTimeoutMs: 250,
          retries: {
            delay: () => 75,
            maxAttempts: 3,
          },
          retryTimeouts: true,
        },
      },
    }
  );

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS lab_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        call_id TEXT,
        attempt INTEGER,
        detail TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lab_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private setMeta(key: string, value: unknown): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO lab_meta (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      JSON.stringify(value)
    );
  }

  private getMeta<T>(key: string): T | undefined {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM lab_meta WHERE key = ?', key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  private record(
    kind: string,
    callId: string | null,
    attempt: number | null,
    detail: Record<string, string | number | boolean | null> = {}
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO lab_events (kind, call_id, attempt, detail, at)
       VALUES (?, ?, ?, ?, ?)`,
      kind,
      callId,
      attempt,
      JSON.stringify(detail),
      Date.now()
    );
    console.log(
      JSON.stringify({
        message: 'runtime-lab-event',
        kind,
        callId,
        attempt,
        ...detail,
      })
    );
  }

  private async applyEffect(
    call: DurableCall<OperationPayload>,
    options: Pick<EffectInput, 'idempotent' | 'mode' | 'failThroughAttempt'>
  ): Promise<EffectResult> {
    const ledger = this.env.EFFECTS.getByName(call.payload.runId);
    return ledger.apply({
      runId: call.payload.runId,
      callId: call.id,
      jobAttempt: call.attempt,
      idempotencyKey: call.id,
      idempotent: options.idempotent,
      mode: options.mode,
      failThroughAttempt: options.failThroughAttempt,
      value: `effect:${call.id}`,
    });
  }

  private async executeOperation(
    call: DurableCall<OperationPayload>
  ): Promise<{ callId: string; attempt: number }> {
    this.activeHandlers += 1;
    this.maxActiveHandlers = Math.max(
      this.maxActiveHandlers,
      this.activeHandlers
    );
    this.setMeta('maxActiveHandlers', this.maxActiveHandlers);
    this.record('handler_started', call.id, call.attempt, {
      scenario: call.payload.scenario,
      activeHandlers: this.activeHandlers,
    });

    try {
      switch (call.payload.scenario) {
        case 'transient-before-effect':
          if (call.attempt <= 2) {
            throw new Error(`Injected transient failure ${call.attempt}/2`);
          }
          break;
        case 'downstream-unavailable':
          await this.applyEffect(call, {
            idempotent: true,
            mode: 'throw-before-commit',
            failThroughAttempt: 2,
          });
          return { callId: call.id, attempt: call.attempt };
        case 'after-effect-idempotent':
          await this.applyEffect(call, {
            idempotent: true,
            mode: 'throw-after-commit',
            failThroughAttempt: 2,
          });
          return { callId: call.id, attempt: call.attempt };
        case 'after-effect-unprotected':
          await this.applyEffect(call, {
            idempotent: false,
            mode: 'throw-after-commit',
            failThroughAttempt: 2,
          });
          return { callId: call.id, attempt: call.attempt };
        case 'crash-before-effect':
          if (
            await this.env.EFFECTS.getByName(call.payload.runId).claimFault(
              `${call.id}:crash-before-effect`,
              1
            )
          ) {
            this.ctx.abort('Injected crash before external effect');
            throw new Error('Durable Object abort did not terminate execution');
          }
          break;
        case 'crash-after-effect-idempotent':
        case 'crash-after-effect-unprotected':
          await this.applyEffect(call, {
            idempotent:
              call.payload.scenario === 'crash-after-effect-idempotent',
            mode: 'success',
            failThroughAttempt: 0,
          });
          if (call.attempt === 1) {
            this.ctx.abort('Injected crash after external effect');
            throw new Error('Durable Object abort did not terminate execution');
          }
          return { callId: call.id, attempt: call.attempt };
        case 'timeout-then-success':
          if (call.attempt === 1) {
            try {
              await waitWithSignal(300, call.signal);
            } catch (error) {
              this.record('handler_aborted', call.id, call.attempt, {
                error: errorLabel(error),
              });
              throw error;
            }
          }
          break;
        case 'timeout-ignores-abort':
          await scheduler.wait(call.attempt === 1 ? 300 : 15);
          break;
        case 'non-retryable':
          throw new NonRetryableError('Injected permanent rejection');
        case 'retry-exhaustion':
          throw new Error(`Injected persistent failure ${call.attempt}/5`);
        case 'concurrency-burst':
          await scheduler.wait(35);
          if (call.attempt === 1) {
            throw new Error('Injected burst failure on first attempt');
          }
          break;
        case 'happy-path':
        case 'duplicate-submission':
        case 'operation-id-collision':
        case 'named-alarm-retry':
        case 'named-alarm-replacement':
          break;
      }

      const effect = await this.applyEffect(call, {
        idempotent: true,
        mode: 'success',
        failThroughAttempt: 0,
      });
      this.record('handler_completed', call.id, call.attempt, {
        effectApplied: effect.applied,
      });
      return { callId: call.id, attempt: call.attempt };
    } catch (error) {
      this.record('handler_failed', call.id, call.attempt, {
        error: errorLabel(error),
      });
      throw error;
    } finally {
      this.activeHandlers -= 1;
    }
  }

  private async executeNamedAlarm(info: DurableAlarmInfo): Promise<void> {
    const config = this.getMeta<{
      runId: string;
      scenario: 'named-alarm-retry' | 'named-alarm-replacement';
    }>('namedAlarm');
    if (!config) {
      throw new NonRetryableError('Missing named alarm scenario metadata');
    }

    this.record('named_alarm_started', `${config.runId}:alarm`, info.attempt, {
      generationKey: info.idempotencyKey,
      scheduledTime: info.scheduledTime,
    });
    const ledger = this.env.EFFECTS.getByName(config.runId);
    await ledger.apply({
      runId: config.runId,
      callId: `${config.runId}:alarm`,
      jobAttempt: info.attempt,
      idempotencyKey: info.idempotencyKey,
      idempotent: true,
      mode: 'named-alarm',
      failThroughAttempt: 0,
      value: `alarm:${config.runId}`,
    });
    if (config.scenario === 'named-alarm-retry' && info.attempt === 1) {
      throw new Error('Injected named alarm failure');
    }
    this.record('named_alarm_completed', `${config.runId}:alarm`, info.attempt);
  }

  private initializeRun(runId: string, scenario: ScenarioId): void {
    this.setMeta('runId', runId);
    this.setMeta('scenario', scenario);
    this.record('run_started', runId, null, { scenario });
  }

  async start(runId: string, scenario: ScenarioId): Promise<void> {
    this.initializeRun(runId, scenario);
    const payload = { runId, callId: runId, scenario };
    if (
      scenario === 'timeout-then-success' ||
      scenario === 'timeout-ignores-abort'
    ) {
      await this.durability.timeoutRun({ id: runId, payload });
      return;
    }
    await this.durability.run({ id: runId, payload });
  }

  async startDuplicate(runId: string): Promise<void> {
    const scenario = 'duplicate-submission' satisfies ScenarioId;
    this.initializeRun(runId, scenario);
    const payload: OperationPayload = { runId, callId: runId, scenario };
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        this.durability.run({ id: runId, payload })
      )
    );
    const rejected = results.filter((result) => result.status === 'rejected');
    this.record('duplicate_batch_registered', runId, null, {
      submissions: results.length,
      rejected: rejected.length,
    });
  }

  async startCollision(runId: string): Promise<void> {
    const scenario = 'operation-id-collision' satisfies ScenarioId;
    this.initializeRun(runId, scenario);
    const payload: OperationPayload = { runId, callId: runId, scenario };
    await this.durability.run({ id: runId, payload });
    try {
      await this.durability.alternate({ id: runId, payload });
    } catch (error) {
      const label = errorLabel(error);
      this.setMeta('collisionError', label);
      this.record('operation_id_collision', runId, null, { error: label });
    }
  }

  async startNamedAlarm(runId: string, replacement: boolean): Promise<void> {
    const scenario = replacement
      ? ('named-alarm-replacement' satisfies ScenarioId)
      : ('named-alarm-retry' satisfies ScenarioId);
    this.initializeRun(runId, scenario);
    this.setMeta('namedAlarm', { runId, scenario });
    if (replacement) {
      await this.durability.alarm.probe(Date.now() + 5_000);
      await this.durability.alarm.probe(Date.now() + 100);
      this.record('named_alarm_replaced', `${runId}:alarm`, null);
      return;
    }
    await this.durability.alarm.probe(Date.now() + 100);
  }

  async startBurst(runId: string): Promise<void> {
    const scenario = 'concurrency-burst' satisfies ScenarioId;
    this.initializeRun(runId, scenario);
    await Promise.all(
      Array.from({ length: 12 }, (_value, index) => {
        const callId = index === 0 ? runId : `${runId}:${index}`;
        return this.durability.run({
          id: callId,
          payload: { runId, callId, scenario },
        });
      })
    );
    this.record('burst_registered', runId, null, { calls: 12 });
  }

  forceAbort(): void {
    this.ctx.abort('Manual runtime lab reset');
  }

  async snapshot(runId: string): Promise<LabSnapshot> {
    const scenario = this.getMeta<ScenarioId>('scenario');
    if (!scenario) {
      throw new Error(`Run "${runId}" has not been initialized`);
    }

    const calls = this.ctx.storage.sql
      .exec<RawCallRow>(
        `SELECT id, operation, status, attempt, next_attempt_at,
                last_error, last_error_name
         FROM durability_calls
         ORDER BY id`
      )
      .toArray()
      .map(
        (row): CallState => ({
          id: row.id,
          operation: row.operation,
          status: row.status,
          attempt: row.attempt,
          nextAttemptAt: row.next_attempt_at,
          lastError: row.last_error,
          lastErrorName: row.last_error_name,
        })
      );
    const alarms = this.ctx.storage.sql
      .exec<RawAlarmRow>(
        `SELECT name, generation_id, status, scheduled_at, next_attempt_at,
                attempt, last_error, last_error_name
         FROM durability_alarms
         ORDER BY name`
      )
      .toArray()
      .map(
        (row): AlarmState => ({
          name: row.name,
          generationId: row.generation_id,
          status: row.status,
          scheduledAt: row.scheduled_at,
          nextAttemptAt: row.next_attempt_at,
          attempt: row.attempt,
          lastError: row.last_error,
          lastErrorName: row.last_error_name,
        })
      );
    const events = this.ctx.storage.sql
      .exec<RawEventRow>(
        `SELECT sequence, kind, call_id, attempt, detail, at
         FROM lab_events
         ORDER BY sequence`
      )
      .toArray()
      .map(
        (row): LabEvent => ({
          sequence: row.sequence,
          kind: row.kind,
          callId: row.call_id,
          attempt: row.attempt,
          detail: row.detail,
          at: row.at,
        })
      );

    return {
      runId,
      scenario,
      calls,
      alarms,
      physicalAlarmAt: await this.ctx.storage.getAlarm(),
      events,
      maxActiveHandlers:
        this.getMeta<number>('maxActiveHandlers') ?? this.maxActiveHandlers,
      collisionError: this.getMeta<string>('collisionError') ?? null,
    };
  }

  override alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.durability.alarm(info);
  }
}
