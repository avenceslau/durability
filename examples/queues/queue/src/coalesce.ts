/**
 * Merges calls that wait for the same destination into one call to it.
 *
 * The first call for a destination is made at once. Calls that arrive while
 * it is on its way wait, and go together in the next one. Nothing is delayed
 * to fill a batch: batches grow only when the destination is slower than the
 * calls arrive, which is when fewer, larger calls help.
 *
 * Each batch is made by one of the calls waiting for it, never by a loop that
 * outlives them: a Worker may only do I/O for a request that is still running.
 */
type Outcome<Output> = { value: Output } | { error: unknown };

type Waiter<Input, Output> = { input: Input; outcome?: Outcome<Output> };

type Lane<Input, Output> = {
  waiting: Waiter<Input, Output>[];
  /** The batch on its way, and when it left. */
  inFlight?: Promise<void>;
  since: number;
};

/**
 * A batch that has been out this long is not coming back: the request that
 * made it was cancelled, and its call with it. Nothing else would release
 * the calls waiting behind it.
 */
const abandonAfterMs = 120_000;

export class CoalescedCallLostError extends Error {
  constructor() {
    super('The call this one was waiting behind never came back');
    this.name = 'CoalescedCallLostError';
  }
}

export const coalescer = <Input, Output>(options: {
  /** Resolves to one output per input, in order. A rejection fails them all. */
  invoke: (key: string, inputs: Input[]) => Promise<Output[]>;
  /** How much of `maxWeight` an input takes. */
  weigh: (input: Input) => number;
  /** A batch takes inputs until this is reached; always at least one. */
  maxWeight: number;
  /** Keeps a request alive until the batch it makes has been handed out. */
  keepAlive?: (work: Promise<unknown>) => void;
}): ((key: string, input: Input) => Promise<Output>) => {
  const lanes = new Map<string, Lane<Input, Output>>();

  /** Never rejects: what the call did is recorded on each waiter. */
  const makeBatch = async (
    key: string,
    lane: Lane<Input, Output>
  ): Promise<void> => {
    let weight = 0;
    let count = 0;
    for (const waiter of lane.waiting) {
      weight += options.weigh(waiter.input);
      if (count > 0 && weight > options.maxWeight) {
        break;
      }
      count += 1;
    }
    const batch = lane.waiting.splice(0, count);
    try {
      const outputs = await options.invoke(
        key,
        batch.map((waiter) => waiter.input)
      );
      for (const [index, waiter] of batch.entries()) {
        waiter.outcome = { value: outputs[index]! };
      }
    } catch (error) {
      for (const waiter of batch) {
        waiter.outcome = { error };
      }
    } finally {
      delete lane.inFlight;
      if (lane.waiting.length === 0 && lanes.get(key) === lane) {
        lanes.delete(key);
      }
    }
  };

  return async (key, input) => {
    let lane = lanes.get(key);
    if (lane?.inFlight && Date.now() - lane.since > abandonAfterMs) {
      lane = undefined;
    }
    if (!lane) {
      lane = { waiting: [], since: 0 };
      lanes.set(key, lane);
    }
    const waiter: Waiter<Input, Output> = { input };
    lane.waiting.push(waiter);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const lost = new Promise<'lost'>((resolve) => {
      timer = setTimeout(() => resolve('lost'), abandonAfterMs);
    });
    try {
      while (waiter.outcome === undefined) {
        if (!lane.inFlight) {
          // Nobody is on the way: this call takes the front of the line with
          // it, which is where it stands unless the line is longer than a batch.
          lane.since = Date.now();
          lane.inFlight = makeBatch(key, lane);
          options.keepAlive?.(lane.inFlight);
        }
        // eslint-disable-next-line no-await-in-loop
        if ((await Promise.race([lane.inFlight, lost])) === 'lost') {
          lane.waiting = lane.waiting.filter((other) => other !== waiter);
          throw new CoalescedCallLostError();
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if ('error' in waiter.outcome) {
      throw waiter.outcome.error;
    }
    return waiter.outcome.value;
  };
};
