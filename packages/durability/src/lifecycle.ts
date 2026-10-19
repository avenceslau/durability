import { traceLifecycle } from './dev.js';
import { reportFailure, type SerializedError } from './errors.js';

export type OperationLifecycleEntity = {
  entityKind: 'operation';
  operation: string;
  id: string;
  generation: string;
};

export type AlarmLifecycleEntity = {
  entityKind: 'named_alarm';
  alarm: string;
  id: string;
  generation: string;
};

export type FanoutLifecycleEntity = {
  entityKind: 'fanout_delivery';
  id: string;
  target: string;
  generation: string;
};

export type OutboxLifecycleEntity = {
  entityKind: 'outbox_entry';
  channel: string;
  /** The staged key. */
  id: string;
  /** The staged version, as a string. */
  generation: string;
};

export type LifecycleEntity =
  | OperationLifecycleEntity
  | AlarmLifecycleEntity
  | FanoutLifecycleEntity
  | OutboxLifecycleEntity;

type AttemptSettled = {
  type: 'attempt_settled';
  timestamp: number;
  attempt: number;
  durationMs: number;
};

/** Best-effort metrics signal for queue lifecycle changes. */
export type DurabilityLifecycleEvent =
  | ((
      | OperationLifecycleEntity
      | FanoutLifecycleEntity
      | OutboxLifecycleEntity
    ) & {
      type: 'registered';
      timestamp: number;
      attempt: 0;
    })
  | (AlarmLifecycleEntity & {
      type: 'scheduled';
      timestamp: number;
      attempt: 0;
      scheduledTime: number;
    })
  | (LifecycleEntity & {
      type: 'attempt_started';
      timestamp: number;
      attempt: number;
    })
  | (LifecycleEntity &
      AttemptSettled & {
        outcome: 'completed';
        /** The handler's return value. Absent for fanout acknowledgements. */
        result?: unknown;
      })
  | (LifecycleEntity &
      AttemptSettled & {
        outcome: 'retry_scheduled';
        error: SerializedError;
        nextAttemptAt: number;
      })
  | (LifecycleEntity &
      AttemptSettled & { outcome: 'failed'; error: SerializedError })
  | (LifecycleEntity & {
      type: 'terminal';
      timestamp: number;
      attempt: number;
      reason: 'attempts_exhausted' | 'dead_lettered' | 'payload_decode_error';
      error: SerializedError;
    })
  | (LifecycleEntity & {
      type: 'cancelled';
      timestamp: number;
      /** Attempts already started when the cancellation won. */
      attempt: number;
      /** The bounded cancellation reason, or null. */
      reason: string | null;
    })
  | {
      type: 'purged';
      entityKind: LifecycleEntity['entityKind'];
      timestamp: number;
      before: number;
      count: number;
    };

export type LifecycleHook = (
  event: DurabilityLifecycleEvent
) => void | Promise<void>;

export type Emit = (event: DurabilityLifecycleEvent) => void;

export type LifecycleHooks = {
  emit: Emit;
  add: (hook: LifecycleHook) => () => void;
};

/** Fans one helper's lifecycle events out to every attached hook. */
export const createLifecycleHooks = (
  emitter: (hook: LifecycleHook) => Emit,
  initial: LifecycleHook | undefined
): LifecycleHooks => {
  const emits = new Set<Emit>();
  const add = (hook: LifecycleHook) => {
    const emit = emitter(hook);
    emits.add(emit);
    return () => {
      emits.delete(emit);
    };
  };
  if (initial) {
    add(initial);
  }
  return {
    emit: traceLifecycle((event) => {
      for (const emit of emits) {
        emit(event);
      }
    }),
    add,
  };
};

/**
 * Wraps a consumer hook so it can never affect queue state: synchronous throws
 * and rejections are logged, and promises ride on `waitUntil` when available.
 */
export const createEmitter = <
  Event extends { entityKind: string; type: string } = DurabilityLifecycleEvent,
>(
  hook: ((event: Event) => void | Promise<void>) | undefined,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined
): ((event: Event) => void) => {
  if (!hook) {
    return () => undefined;
  }
  return (event) => {
    const report = (error: unknown): void =>
      reportFailure(
        'durability.lifecycle_hook.failed',
        {
          entityKind: event.entityKind,
          lifecycleType: event.type,
          entityId: 'id' in event ? event.id : 'durability',
        },
        error
      );
    try {
      const result = hook(event);
      if (result === undefined) {
        return;
      }
      const caught = Promise.resolve(result).catch(report);
      if (!waitUntil) {
        return;
      }
      try {
        waitUntil(caught);
      } catch (error) {
        report(error);
      }
    } catch (error) {
      report(error);
    }
  };
};
