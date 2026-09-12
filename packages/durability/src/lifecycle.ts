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

export type LifecycleEntity = OperationLifecycleEntity | AlarmLifecycleEntity;

type AttemptSettled = {
  type: 'attempt_settled';
  timestamp: number;
  attempt: number;
  durationMs: number;
};

/** Best-effort metrics signal for queue lifecycle changes. */
export type DurabilityLifecycleEvent =
  | (OperationLifecycleEntity & {
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
  | (LifecycleEntity & AttemptSettled & { outcome: 'completed' })
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
      reason: 'attempts_exhausted';
      error: SerializedError;
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

/**
 * Wraps a consumer hook so it can never affect queue state: synchronous throws
 * and rejections are logged, and promises ride on `waitUntil` when available.
 */
export const createEmitter = (
  hook: LifecycleHook | undefined,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined
): Emit => {
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
