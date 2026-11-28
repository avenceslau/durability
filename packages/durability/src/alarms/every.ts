import * as v from 'valibot';
import type { DurabilityAlarmMethodOptions } from '../policy.js';
import { isFunction, isNumber, isObject } from '../predicates.js';
import type { DurableAlarmInfo } from './index.js';

/** Milliseconds until the next occurrence, or a function returning them, such as one adding jitter. */
export type AlarmPeriod = number | (() => number);

/**
 * One period for every level, or periods keyed by activity level. `'*'`
 * applies to levels without their own key. A level with no period does not
 * run the alarm.
 */
export type AlarmPeriods = AlarmPeriod | Readonly<Record<string, AlarmPeriod>>;

/** Information passed to a recurring alarm handler, with the level it runs at. */
export type RecurringAlarmInfo<Level extends string | undefined> =
  DurableAlarmInfo & {
    /** Activity level when the attempt started; undefined without `activity`. */
    level: Level;
  };

type PeriodLevels<Periods> = Periods extends AlarmPeriod
  ? never
  : keyof Periods & string;

type RunLevel<Periods> = Periods extends AlarmPeriod
  ? string | undefined
  : '*' extends keyof Periods
    ? string | undefined
    : keyof Periods & string;

/** A handler built by {@link every}. */
export type RecurringAlarm<Level extends string = string> = {
  readonly periods: AlarmPeriods;
  readonly options: DurabilityAlarmMethodOptions | undefined;
  run(info: RecurringAlarmInfo<string | undefined>): void | Promise<void>;
  /** Type-only: the levels `periods` lists, checked against `activity`. */
  readonly levels?: readonly Level[];
};

export type RecurringAlarmEntry = {
  periods: AlarmPeriod | ReadonlyMap<string, AlarmPeriod>;
  run: RecurringAlarm['run'];
};

export const isAlarmPeriod = <Other>(
  periods: AlarmPeriod | Other
): periods is AlarmPeriod => isNumber(periods) || isFunction(periods);

const assertPeriod = (period: number): void => {
  if (!Number.isFinite(period) || period <= 0) {
    throw new RangeError('every() periods must be positive numbers');
  }
};

const alarmPeriodSchema = v.custom<AlarmPeriod>(isAlarmPeriod);

export const recurringAlarmSchema = v.object({
  periods: v.union([
    alarmPeriodSchema,
    v.record(v.string(), alarmPeriodSchema),
  ]),
  run: v.custom<RecurringAlarm['run']>(isFunction),
  // Parsed with the other method policies by createPolicyResolver.
  options: v.optional(v.custom<DurabilityAlarmMethodOptions>(isObject)),
});

/**
 * Makes a named alarm recur: after each run it schedules its next occurrence
 * from the period of the current activity level.
 *
 * @example
 * ```ts
 * handlers: {
 *   sweep: every({ draining: 5_000, active: 30_000 }, ({ level }) => sweep(level)),
 *   snapshot: every(3_600_000, () => snapshot(), { retries: { maxAttempts: 2 } }),
 * }
 * ```
 */
export const every = <const Periods extends AlarmPeriods>(
  periods: Periods,
  run: (info: RecurringAlarmInfo<RunLevel<Periods>>) => void | Promise<void>,
  options?: DurabilityAlarmMethodOptions
): RecurringAlarm<PeriodLevels<Periods>> => {
  const listed = isAlarmPeriod(periods) ? [periods] : Object.values(periods);

  for (const period of listed) {
    if (isNumber(period)) {
      assertPeriod(period);
    }
  }

  return { periods, run, options };
};

export const periodFor = (
  periods: RecurringAlarmEntry['periods'],
  level: string | undefined
): AlarmPeriod | undefined => {
  if (isAlarmPeriod(periods)) {
    return periods;
  }

  return (
    (level === undefined ? undefined : periods.get(level)) ?? periods.get('*')
  );
};

export const nextRunAt = (period: AlarmPeriod, now: number): number => {
  const delay = isFunction(period) ? period() : period;
  assertPeriod(delay);

  return Math.ceil(now + delay);
};
