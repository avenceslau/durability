import {
  createDurability,
  NonRetryableError,
  type DurableCall,
  type Durability,
} from './index.js';

/** A duration in milliseconds. */
export type WorkflowDuration = number;

/** Input and identity supplied to a workflow run. */
export type WorkflowEvent<Payload> = {
  instanceId: string;
  payload: Readonly<Payload>;
  timestamp: Date;
};

/** Backoff applied between attempts of a failed workflow step. */
export type WorkflowStepBackoff = 'constant' | 'linear' | 'exponential';

/** Retry and timeout behavior for one `step.do` call. */
export type WorkflowStepConfig = {
  retries?: {
    /** Total attempts, including the first execution. Defaults to 5. */
    limit: number;
    /** Initial delay between attempts in milliseconds. Defaults to 10 seconds. */
    delay: number;
    /** Defaults to `exponential`. */
    backoff?: WorkflowStepBackoff;
  };
  /** Timeout for each attempt in milliseconds. Defaults to 10 minutes. */
  timeout?: number;
};

/** Resolved metadata passed to a `step.do` callback. */
export type WorkflowStepContext = {
  attempt: number;
  config: {
    retries: {
      limit: number;
      delay: number;
      backoff: WorkflowStepBackoff;
    };
    timeout: number;
  };
  signal: AbortSignal;
  step: {
    count: number;
    name: string;
  };
};

type WorkflowStepCallback<Result> = (
  context: WorkflowStepContext
) => Result | Promise<Result>;

/** Durable operations available inside a workflow. */
export type WorkflowStep = {
  /** Runs a callback with the default retry and timeout policy. */
  do<Result>(
    name: string,
    callback: WorkflowStepCallback<Result>
  ): Promise<Awaited<Result>>;
  /** Runs a callback with a step-specific retry and timeout policy. */
  do<Result>(
    name: string,
    config: WorkflowStepConfig,
    callback: WorkflowStepCallback<Result>
  ): Promise<Awaited<Result>>;
  /** Suspends the workflow without keeping the Durable Object active. */
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
};

/** Current state of the workflow instance stored in one Durable Object. */
export type WorkflowStatus<Result> =
  | { status: 'not_started' }
  | { status: 'running' }
  | { status: 'sleeping'; wakeAt: number }
  | { status: 'errored'; error: { name: string; message: string } }
  | { status: 'complete'; result: Result };

/** A single workflow instance backed by one Durable Object. */
export type Workflow<Payload, Result> = {
  /** Starts the workflow. Repeated calls are deduplicated by the instance. */
  start(payload: Payload): Promise<void>;
  /** Reads the persisted workflow state. */
  status(): Promise<WorkflowStatus<Result>>;
  /** Processes retries and sleep wake-ups from the Durable Object alarm. */
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void>;
};

/** A function replayed from the beginning whenever its workflow resumes. */
export type WorkflowHandler<Payload, Result> = (
  event: Readonly<WorkflowEvent<Payload>>,
  step: WorkflowStep
) => Result | Promise<Result>;

type InternalRunPayload<Payload> =
  | { kind: 'start'; payload: Payload; timestamp: number }
  | { kind: 'resume' };

type InternalHandlers<Payload> = {
  runWorkflow: (
    call: DurableCall<InternalRunPayload<Payload>>
  ) => Promise<void>;
};

type InternalAlarmName = 'workflowResume';

type InstanceRow = {
  created_at: number;
  current_run_id: string;
  payload: string;
  result: string | null;
  sleep_sequence: number | null;
  status: 'running' | 'sleeping' | 'complete';
};

type StepRow = {
  attempt: number;
  config: string | null;
  kind: 'do' | 'sleep';
  last_error: string | null;
  last_error_name: string | null;
  name: string;
  result: string | null;
  sequence: number;
  status: 'retrying' | 'sleeping' | 'completed' | 'failed';
  wake_at: number | null;
};

type StoredValue = { kind: 'undefined' } | { kind: 'value'; value: unknown };

const instanceTable = 'durability_workflow_instance';
const stepTable = 'durability_workflow_steps';
const initialRunId = 'durability:workflow:run:0';
const suspended = Symbol('workflow suspended');
const defaultStepConfig = {
  retries: {
    limit: 5,
    delay: 10_000,
    backoff: 'exponential',
  },
  timeout: 10 * 60_000,
} satisfies WorkflowStepContext['config'];

class WorkflowStepTimeoutError extends Error {
  constructor(name: string, timeout: number) {
    super(`Workflow step "${name}" timed out after ${timeout}ms`);
    this.name = 'WorkflowStepTimeoutError';
  }
}

const serialize = (value: unknown, label: string): string => {
  try {
    const stored: StoredValue =
      value === undefined ? { kind: 'undefined' } : { kind: 'value', value };
    const serialized = JSON.stringify(stored);
    if (serialized === undefined) {
      throw new TypeError('JSON.stringify returned undefined');
    }
    return serialized;
  } catch (error) {
    const serializationError = new TypeError(
      `${label} must be JSON-serializable`
    );
    Object.defineProperty(serializationError, 'cause', { value: error });
    throw serializationError;
  }
};

const deserialize = <Value>(serialized: string): Value => {
  const stored = JSON.parse(serialized) as StoredValue;
  if (stored.kind === 'undefined') {
    return undefined as Value;
  }
  return stored.value as Value;
};

const assertStepMatches = (
  row: StepRow,
  sequence: number,
  name: string,
  kind: StepRow['kind']
): void => {
  if (row.name === name && row.kind === kind) {
    return;
  }
  throw new Error(
    `Workflow replay diverged at step ${sequence}: expected ${row.kind} "${row.name}", received ${kind} "${name}"`
  );
};

const resolveStepConfig = (
  config: WorkflowStepConfig | undefined
): WorkflowStepContext['config'] => {
  const resolved = {
    retries: {
      limit: config?.retries?.limit ?? defaultStepConfig.retries.limit,
      delay: config?.retries?.delay ?? defaultStepConfig.retries.delay,
      backoff: config?.retries?.backoff ?? defaultStepConfig.retries.backoff,
    },
    timeout: config?.timeout ?? defaultStepConfig.timeout,
  };
  if (
    !Number.isInteger(resolved.retries.limit) ||
    resolved.retries.limit < 1 ||
    resolved.retries.limit > 10_000
  ) {
    throw new RangeError(
      'Workflow step retry limit must be an integer between 1 and 10000'
    );
  }
  if (
    resolved.retries.backoff !== 'constant' &&
    resolved.retries.backoff !== 'linear' &&
    resolved.retries.backoff !== 'exponential'
  ) {
    throw new RangeError(
      'Workflow step backoff must be constant, linear, or exponential'
    );
  }
  if (
    !Number.isSafeInteger(resolved.retries.delay) ||
    resolved.retries.delay < 0
  ) {
    throw new RangeError(
      'Workflow step retry delay must be a non-negative safe integer'
    );
  }
  if (!Number.isSafeInteger(resolved.timeout) || resolved.timeout < 1) {
    throw new RangeError(
      'Workflow step timeout must be a positive safe integer'
    );
  }
  return resolved;
};

const retryDelay = (
  delay: number,
  failedAttempt: number,
  backoff: WorkflowStepBackoff
): number => {
  let multiplier: number;
  switch (backoff) {
    case 'constant':
      multiplier = 1;
      break;
    case 'linear':
      multiplier = failedAttempt;
      break;
    case 'exponential':
      multiplier = 2 ** (failedAttempt - 1);
      break;
  }
  const result = delay * multiplier;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(
      'Workflow step retry delay exceeds the safe integer range'
    );
  }
  return result;
};

const errorDetails = (error: unknown): { name: string; message: string } => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'Error', message: String(error) };
};

/**
 * Creates a Workflows-like replay loop that executes entirely inside one
 * SQLite-backed Durable Object.
 *
 * Completed `step.do` results are replayed from SQLite, while `step.sleep`
 * delegates wake-ups and retries to durability's shared alarm scheduler. The
 * Durable Object must forward its `alarm` method to the returned workflow.
 */
export const createWorkflow = <Payload, Result>(
  context: Pick<DurableObjectState, 'id' | 'storage'> &
    Partial<Pick<DurableObjectState, 'waitUntil'>>,
  handler: WorkflowHandler<Payload, Result>
): Workflow<Payload, Result> => {
  context.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${instanceTable} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'sleeping', 'complete')),
      result TEXT,
      current_run_id TEXT NOT NULL,
      sleep_sequence INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${stepTable} (
      sequence INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('do', 'sleep')),
      status TEXT NOT NULL CHECK (
        status IN ('retrying', 'sleeping', 'completed', 'failed')
      ),
      result TEXT,
      config TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      wake_at INTEGER,
      last_error TEXT,
      last_error_name TEXT
    );
  `);

  const getInstance = (): InstanceRow | undefined =>
    context.storage.sql
      .exec<InstanceRow>(
        `SELECT payload, status, result, current_run_id, sleep_sequence, created_at
         FROM ${instanceTable}
         WHERE singleton = 1`
      )
      .toArray()[0];

  const getStep = (sequence: number): StepRow | undefined =>
    context.storage.sql
      .exec<StepRow>(
        `SELECT sequence, name, kind, status, result, config, attempt, wake_at,
                last_error, last_error_name
         FROM ${stepTable}
         WHERE sequence = ?`,
        sequence
      )
      .toArray()[0];

  const getStepCount = (name: string, sequence: number): number =>
    context.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) + 1 AS count
         FROM ${stepTable}
         WHERE kind = 'do' AND name = ? AND sequence < ?`,
        name,
        sequence
      )
      .toArray()[0]?.count ?? 1;

  const getNextWait = (): StepRow | undefined =>
    context.storage.sql
      .exec<StepRow>(
        `SELECT sequence, name, kind, status, result, config, attempt, wake_at,
                last_error, last_error_name
         FROM ${stepTable}
         WHERE status IN ('retrying', 'sleeping') AND wake_at IS NOT NULL
         ORDER BY wake_at, sequence
         LIMIT 1`
      )
      .toArray()[0];

  let durability: Durability<InternalHandlers<Payload>, InternalAlarmName>;
  const activeStepAttempts = new Map<number, Promise<void>>();

  const scheduleNextResume = async (): Promise<void> => {
    const next = getNextWait();
    if (!next || next.wake_at === null) {
      return;
    }
    await durability.alarm.workflowResume(next.wake_at);
  };

  const runStepAttempt = async <StepResult>(
    sequence: number,
    name: string,
    stepCount: number,
    attempt: number,
    config: WorkflowStepContext['config'],
    callback: WorkflowStepCallback<StepResult>
  ): Promise<Awaited<StepResult>> => {
    await activeStepAttempts.get(sequence);

    const controller = new AbortController();
    const execution = (async () =>
      callback({
        attempt,
        config,
        signal: controller.signal,
        step: { count: stepCount, name },
      }))();
    const settled = execution.then(
      () => undefined,
      () => undefined
    );
    activeStepAttempts.set(sequence, settled);
    void settled.finally(() => {
      if (activeStepAttempts.get(sequence) === settled) {
        activeStepAttempts.delete(sequence);
      }
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        execution,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new WorkflowStepTimeoutError(name, config.timeout);
            controller.abort(error);
            reject(error);
          }, config.timeout);
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  };

  const queueRun = async (sequence: number): Promise<void> => {
    const attempt = getStep(sequence)?.attempt ?? 0;
    const runId = `durability:workflow:run:${sequence + 1}:${attempt}`;
    context.storage.sql.exec(
      `UPDATE ${instanceTable}
       SET status = 'running', current_run_id = ?, sleep_sequence = NULL
       WHERE singleton = 1 AND status != 'complete'`,
      runId
    );
    await durability.runWorkflow({ id: runId, payload: { kind: 'resume' } });
  };

  const executeWorkflow = async (
    call: DurableCall<InternalRunPayload<Payload>>
  ): Promise<void> => {
    let instance = getInstance();
    if (!instance && call.payload.kind === 'start') {
      context.storage.sql.exec(
        `INSERT INTO ${instanceTable}
          (singleton, payload, status, current_run_id, created_at)
         VALUES (1, ?, 'running', ?, ?)
         ON CONFLICT(singleton) DO NOTHING`,
        serialize(call.payload.payload, 'Workflow payload'),
        call.id,
        call.payload.timestamp
      );
      instance = getInstance();
    }
    if (!instance) {
      throw new NonRetryableError('Workflow was resumed before it was started');
    }
    if (instance.status === 'complete') {
      return;
    }

    let nextSequence = 0;

    const activeDoCalls = new Set<Promise<unknown>>();

    async function executeDoStep<StepResult>(
      name: string,
      configOrCallback: WorkflowStepConfig | WorkflowStepCallback<StepResult>,
      configuredCallback?: WorkflowStepCallback<StepResult>
    ): Promise<Awaited<StepResult>> {
      const sequence = nextSequence;
      nextSequence += 1;
      const config = resolveStepConfig(
        typeof configOrCallback === 'function' ? undefined : configOrCallback
      );
      const callback =
        typeof configOrCallback === 'function'
          ? configOrCallback
          : configuredCallback;
      if (!callback) {
        throw new TypeError(`Workflow step "${name}" requires a callback`);
      }

      const serializedConfig = serialize(config, 'Workflow step config');
      let existing = getStep(sequence);
      if (existing) {
        assertStepMatches(existing, sequence, name, 'do');
        if (existing.config !== serializedConfig) {
          throw new Error(
            `Workflow replay diverged at step ${sequence}: step config changed`
          );
        }
        if (existing.status === 'completed') {
          if (existing.result === null) {
            throw new Error(
              `Completed workflow step ${sequence} has no result`
            );
          }
          return deserialize<Awaited<StepResult>>(existing.result);
        }
        if (existing.status === 'failed') {
          throw new NonRetryableError(
            existing.last_error ?? `Workflow step "${name}" failed`
          );
        }
        if (existing.wake_at !== null && existing.wake_at > Date.now()) {
          context.storage.sql.exec(
            `UPDATE ${instanceTable}
             SET status = 'sleeping', sleep_sequence = ?
             WHERE singleton = 1`,
            sequence
          );
          await scheduleNextResume();
          throw suspended;
        }
      } else {
        context.storage.sql.exec(
          `INSERT INTO ${stepTable}
            (sequence, name, kind, status, config)
           VALUES (?, ?, 'do', 'retrying', ?)`,
          sequence,
          name,
          serializedConfig
        );
        existing = getStep(sequence);
      }
      if (!existing) {
        throw new Error(`Workflow step ${sequence} was not persisted`);
      }

      const attempt = existing.attempt + 1;
      context.storage.sql.exec(
        `UPDATE ${stepTable}
         SET attempt = ?, wake_at = NULL
         WHERE sequence = ?`,
        attempt,
        sequence
      );

      try {
        const result = await runStepAttempt(
          sequence,
          name,
          getStepCount(name, sequence),
          attempt,
          config,
          callback
        );
        const serialized = serialize(
          result,
          `Result for workflow step "${name}"`
        );
        context.storage.sql.exec(
          `UPDATE ${stepTable}
           SET status = 'completed', result = ?, wake_at = NULL,
               last_error = NULL, last_error_name = NULL
           WHERE sequence = ?`,
          serialized,
          sequence
        );
        return result;
      } catch (error) {
        const details = errorDetails(error);
        const terminal =
          attempt >= config.retries.limit ||
          details.name === 'NonRetryableError';
        if (terminal) {
          context.storage.sql.exec(
            `UPDATE ${stepTable}
             SET status = 'failed', wake_at = NULL, last_error = ?,
                 last_error_name = ?
             WHERE sequence = ?`,
            details.message,
            details.name,
            sequence
          );
          throw new NonRetryableError(details.message);
        }

        const delay = retryDelay(
          config.retries.delay,
          attempt,
          config.retries.backoff
        );
        const wakeAt = Date.now() + delay;
        if (!Number.isSafeInteger(wakeAt)) {
          throw new RangeError(
            'Workflow step retry time exceeds the safe integer range'
          );
        }
        context.storage.sql.exec(
          `UPDATE ${stepTable}
           SET status = 'retrying', wake_at = ?, last_error = ?,
               last_error_name = ?
           WHERE sequence = ?`,
          wakeAt,
          details.message,
          details.name,
          sequence
        );
        context.storage.sql.exec(
          `UPDATE ${instanceTable}
           SET status = 'sleeping', sleep_sequence = ?
           WHERE singleton = 1`,
          sequence
        );
        await scheduleNextResume();
        throw suspended;
      }
    }

    function doStep<StepResult>(
      name: string,
      callback: WorkflowStepCallback<StepResult>
    ): Promise<Awaited<StepResult>>;
    function doStep<StepResult>(
      name: string,
      config: WorkflowStepConfig,
      callback: WorkflowStepCallback<StepResult>
    ): Promise<Awaited<StepResult>>;
    function doStep<StepResult>(
      name: string,
      configOrCallback: WorkflowStepConfig | WorkflowStepCallback<StepResult>,
      configuredCallback?: WorkflowStepCallback<StepResult>
    ): Promise<Awaited<StepResult>> {
      const execution = executeDoStep(
        name,
        configOrCallback,
        configuredCallback
      );
      activeDoCalls.add(execution);
      void execution.then(
        () => activeDoCalls.delete(execution),
        () => activeDoCalls.delete(execution)
      );
      return execution;
    }

    const step: WorkflowStep = {
      do: doStep,

      async sleep(name: string, duration: WorkflowDuration): Promise<void> {
        const sequence = nextSequence;
        nextSequence += 1;
        const existing = getStep(sequence);
        if (existing) {
          assertStepMatches(existing, sequence, name, 'sleep');
          if (existing.status === 'completed') {
            return;
          }
          if (existing.wake_at === null) {
            throw new Error(
              `Sleeping workflow step ${sequence} has no wake time`
            );
          }
          if (existing.wake_at <= Date.now()) {
            context.storage.sql.exec(
              `UPDATE ${stepTable}
               SET status = 'completed'
               WHERE sequence = ?`,
              sequence
            );
            return;
          }

          context.storage.sql.exec(
            `UPDATE ${instanceTable}
             SET status = 'sleeping', sleep_sequence = ?
             WHERE singleton = 1`,
            sequence
          );
          await scheduleNextResume();
          throw suspended;
        }

        if (!Number.isSafeInteger(duration) || duration < 0) {
          throw new RangeError(
            'Workflow sleep duration must be a non-negative safe integer'
          );
        }
        const wakeAt = Date.now() + duration;
        if (!Number.isSafeInteger(wakeAt)) {
          throw new RangeError(
            'Workflow sleep wake time exceeds the safe integer range'
          );
        }
        context.storage.sql.exec(
          `INSERT INTO ${stepTable}
            (sequence, name, kind, status, wake_at)
           VALUES (?, ?, 'sleep', 'sleeping', ?)`,
          sequence,
          name,
          wakeAt
        );
        context.storage.sql.exec(
          `UPDATE ${instanceTable}
           SET status = 'sleeping', sleep_sequence = ?
           WHERE singleton = 1`,
          sequence
        );
        await scheduleNextResume();
        throw suspended;
      },
    };

    const event: WorkflowEvent<Payload> = {
      instanceId: context.id.toString(),
      payload: deserialize<Payload>(instance.payload),
      timestamp: new Date(instance.created_at),
    };

    try {
      const result = await handler(event, step);
      context.storage.sql.exec(
        `UPDATE ${instanceTable}
         SET status = 'complete', result = ?, sleep_sequence = NULL
         WHERE singleton = 1`,
        serialize(result, 'Workflow result')
      );
    } catch (error) {
      await Promise.allSettled([...activeDoCalls]);
      if (error === suspended) {
        return;
      }
      throw error;
    }
  };

  const handlers: InternalHandlers<Payload> = {
    runWorkflow: executeWorkflow,
  };
  durability = createDurability(context, handlers, {
    methods: {
      runWorkflow: { attemptTimeoutMs: 15 * 60_000 },
    },
    alarms: {
      workflowResume: async () => {
        const instance = getInstance();
        if (!instance || instance.status === 'complete') {
          return;
        }

        const next = getNextWait();
        if (!next || next.wake_at === null) {
          return;
        }
        if (next.wake_at > Date.now()) {
          await scheduleNextResume();
          return;
        }
        await queueRun(next.sequence);
      },
    },
  });

  const status = async (): Promise<WorkflowStatus<Result>> => {
    const instance = getInstance();
    if (!instance) {
      const initial = await durability.runWorkflow.getResult(initialRunId);
      if (initial.status === 'not_found') {
        return { status: 'not_started' };
      }
      if (initial.status === 'failed') {
        return { status: 'errored', error: initial.error };
      }
      return { status: 'running' };
    }
    if (instance.status === 'complete') {
      if (instance.result === null) {
        throw new Error('Completed workflow has no result');
      }
      return {
        status: 'complete',
        result: deserialize<Result>(instance.result),
      };
    }
    if (instance.status === 'sleeping') {
      const next = getNextWait();
      if (!next || next.wake_at === null) {
        throw new Error('Sleeping workflow has no wake time');
      }
      return { status: 'sleeping', wakeAt: next.wake_at };
    }

    const run = await durability.runWorkflow.getResult(instance.current_run_id);
    if (run.status === 'failed') {
      return { status: 'errored', error: run.error };
    }
    return { status: 'running' };
  };

  return {
    start: (payload) =>
      durability.runWorkflow({
        id: initialRunId,
        payload: { kind: 'start', payload, timestamp: Date.now() },
      }),
    status,
    alarm: durability.alarm,
  };
};
