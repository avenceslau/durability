import { reportFailure } from './errors.js';

// setTimeout overflows past 2^31 - 1 ms and fires at once. A longer wait is
// set for this long, finds nothing due when it fires, and is set again.
const maxNativeDelayMs = 2 ** 31 - 1;

type Entry = {
  dueAt: number;
  // Keeps callbacks due at the same time in the order they were scheduled.
  order: number;
  // Position in the heap, or -1 once the entry is due or has been cancelled.
  index: number;
  // Removed by a cancel, which can arrive after the entry left the heap as
  // due but before its turn among the callbacks due with it.
  callback: (() => void) | undefined;
};

const isBefore = (firstEntry: Entry, secondEntry: Entry): boolean =>
  firstEntry.dueAt < secondEntry.dueAt ||
  (firstEntry.dueAt === secondEntry.dueAt &&
    firstEntry.order < secondEntry.order);

/**
 * Runs callbacks after a delay like `setTimeout`, but keeps every pending
 * callback in a min-heap ordered by due time and sets one native timer for the
 * earliest. workerd makes `setTimeout` throw once 10,000 native timers are
 * pending, so an object whose open timeouts grow with its workload schedules
 * them here instead of setting a native timer for each.
 *
 * Callbacks due together run one after another in the same task, so promise
 * reactions queued by one do not run before the next as they would between
 * separate native timers. A callback scheduled by one of them runs in a later
 * task even with no delay.
 *
 * A native timer belongs to the request or Durable Object that set it, so an
 * instance must not be shared between them.
 */
export class SharedTimer {
  readonly #heap: Entry[] = [];
  #scheduledCount = 0;
  #nativeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Callbacks that have neither run nor been cancelled. */
  get pendingCount(): number {
    return this.#heap.length;
  }

  /** Runs `callback` once after `delayMs` and returns a function that cancels it. */
  schedule(callback: () => void, delayMs: number): () => void {
    const entry: Entry = {
      // performance.now() rather than Date.now(): a native timer counts
      // elapsed time, which a change to the wall clock does not affect.
      dueAt: performance.now() + (delayMs > 0 ? delayMs : 0),
      order: this.#scheduledCount++,
      index: this.#heap.length,
      callback,
    };
    this.#heap.push(entry);
    this.#moveUp(entry);

    // The native timer is also missing if setting it failed in #runDue; the
    // entries left without one get it back here.
    if (entry.index === 0 || this.#nativeTimer === undefined) {
      try {
        this.#setNativeTimer();
      } catch (error) {
        // The caller gets the error instead of a cancel function, so the
        // callback must not stay behind and run later.
        this.#remove(entry);
        throw error;
      }
    }

    return () => {
      entry.callback = undefined;
      if (entry.index === -1) {
        return;
      }

      const wasEarliest = entry.index === 0;
      this.#remove(entry);
      if (wasEarliest) {
        this.#setNativeTimer();
      }
    };
  }

  /**
   * Settles like `work`, or rejects with the error from `onTimeout` when
   * `work` is still pending after `timeoutMs`.
   */
  async withTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
    onTimeout: () => Error
  ): Promise<T> {
    let cancelTimeout: (() => void) | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          cancelTimeout = this.schedule(() => reject(onTimeout()), timeoutMs);
        }),
      ]);
    } finally {
      cancelTimeout?.();
    }
  }

  #setNativeTimer(): void {
    clearTimeout(this.#nativeTimer);
    this.#nativeTimer = undefined;

    const earliest = this.#heap[0];
    if (earliest === undefined) {
      return;
    }

    const now = performance.now();
    const wakeAt = Math.min(earliest.dueAt, now + maxNativeDelayMs);
    this.#nativeTimer = setTimeout(
      () => this.#runDue(wakeAt),
      Math.max(wakeAt - now, 0)
    );
  }

  #runDue(wakeAt: number): void {
    // setTimeout drops the fraction of a delay, so it can fire just before the
    // clock reaches `wakeAt`. Counting that as reached runs the callback now
    // instead of setting another timer for the remaining fraction.
    const now = Math.max(performance.now(), wakeAt);

    const due: Entry[] = [];
    let earliest = this.#heap[0];
    while (earliest !== undefined && earliest.dueAt <= now) {
      this.#remove(earliest);
      due.push(earliest);
      earliest = this.#heap[0];
    }

    // Set before the callbacks run, and by clearing the native timer that is
    // firing: workerd counts it as pending until this function returns, and a
    // callback could take the last one the runtime allows. Clearing one and
    // setting one cannot fail at that limit, so the entries still in the heap
    // always keep a native timer.
    try {
      this.#setNativeTimer();
    } catch (error) {
      reportFailure(
        'durability.timer.set_failed',
        { pendingCount: this.#heap.length },
        error
      );
    }

    for (const entry of due) {
      try {
        entry.callback?.();
      } catch (error) {
        // A throw must not keep the callbacks behind it from running.
        reportFailure(
          'durability.timer.callback_failed',
          { dueAt: entry.dueAt, scheduledOrder: entry.order },
          error
        );
      }
    }
  }

  #remove(entry: Entry): void {
    const { index } = entry;
    entry.index = -1;

    const last = this.#heap.pop();
    if (last === undefined || last === entry) {
      return;
    }

    this.#place(last, index);
    this.#moveUp(last);
    this.#moveDown(last);
  }

  #place(entry: Entry, index: number): void {
    this.#heap[index] = entry;
    entry.index = index;
  }

  #moveUp(entry: Entry): void {
    let { index } = entry;

    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = this.#heap[parentIndex];
      if (parent === undefined || !isBefore(entry, parent)) {
        break;
      }
      this.#place(parent, index);
      index = parentIndex;
    }

    this.#place(entry, index);
  }

  #moveDown(entry: Entry): void {
    let { index } = entry;

    for (;;) {
      const leftIndex = 2 * index + 1;
      const left = this.#heap[leftIndex];
      if (left === undefined) {
        break;
      }
      const right = this.#heap[leftIndex + 1];
      let child = left;
      if (right !== undefined && isBefore(right, left)) {
        child = right;
      }
      if (!isBefore(child, entry)) {
        break;
      }
      const childIndex = child.index;
      this.#place(child, index);
      index = childIndex;
    }

    this.#place(entry, index);
  }
}
