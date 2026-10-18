import { serializeError } from './errors.js';

// Replaced by the consumer's bundler (`define`); see the README's "Dev mode" section.
declare const __DURABILITY_DEV__: boolean | undefined;

/**
 * True only when the build defines `__DURABILITY_DEV__` as `true`. Bundlers
 * fold the check to a constant, so production builds pay one branch per
 * traced call and log nothing.
 */
const devMode = typeof __DURABILITY_DEV__ === 'boolean' && __DURABILITY_DEV__;

let sequence = 0;

/**
 * Logs one dev-mode trace entry and returns its sequence number. The sequence
 * is process-wide and monotonic so interleaved async work can be reordered
 * and correlated when replaying a simulation.
 */
export const trace = (
  operation: string,
  details: Record<string, unknown> = {}
): number => {
  if (!devMode) {
    return 0;
  }
  sequence += 1;
  // Tracing is best-effort: a logger that throws must not change the operation.
  try {
    console.debug({
      event: `durability.dev.${operation}`,
      seq: sequence,
      at: Date.now(),
      ...details,
    });
  } catch {
    // Keep the sequence number so later entries still order correctly.
  }
  return sequence;
};

const traceCall = <T>(
  operation: string,
  details: Record<string, unknown>,
  run: () => T
): T => {
  const call = trace(operation, details);
  let result: T;
  try {
    result = run();
  } catch (error) {
    trace(`${operation}.throw`, { call, error: serializeError(error) });
    throw error;
  }
  if (!(result instanceof Promise)) {
    trace(`${operation}.return`, { call, result });
    return result;
  }
  // Observes the promise without changing what the caller sees.
  void result.then(
    (value: unknown) => trace(`${operation}.return`, { call, result: value }),
    (error: unknown) =>
      trace(`${operation}.throw`, { call, error: serializeError(error) })
  );
  return result;
};

const loggableArgs = (args: readonly unknown[]): unknown[] =>
  args.filter((arg) => typeof arg !== 'function');

/**
 * Wraps a public function so dev mode logs its arguments and outcome. `details`
 * identifies the receiver when the arguments alone do not.
 */
export const traceFunction = <Args extends unknown[], Result>(
  method: string,
  fn: (...args: Args) => Result,
  details: Record<string, unknown> = {}
): ((...args: Args) => Result) => {
  if (!devMode) {
    return fn;
  }
  return function (this: unknown, ...args: Args): Result {
    return traceCall(
      'call',
      { method, ...details, args: loggableArgs(args) },
      () => fn.apply(this, args)
    );
  };
};

/** Wraps every method on a class prototype with {@link traceFunction}. */
export const traceMethods = (prototype: object, owner: string): void => {
  if (!devMode) {
    return;
  }
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (name === 'constructor' || typeof descriptor?.value !== 'function') {
      continue;
    }
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value: traceFunction(`${owner}.${name}`, descriptor.value),
    });
  }
};

/** Logs each lifecycle event before `emit` hands it to the consumer's hooks. */
export const traceLifecycle = <Event extends Record<string, unknown>>(
  emit: (event: Event) => void
): ((event: Event) => void) => {
  if (!devMode) {
    return emit;
  }
  return (event) => {
    trace('lifecycle', event);
    emit(event);
  };
};

const compactQuery = (query: string): string =>
  query.replace(/\s+/g, ' ').trim();

const traceSql = (sql: SqlStorage): SqlStorage =>
  new Proxy(sql, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key === 'exec') {
        return (query: string, ...bindings: SqlStorageValue[]) => {
          trace('sql', { query: compactQuery(query), bindings });
          return target.exec(query, ...bindings);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

const proxyStorage = <Storage extends object>(
  storage: Storage,
  scope: string
): Storage => {
  let sql: SqlStorage | undefined;
  return new Proxy(storage, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key === 'sql' && value !== undefined) {
        sql ??= traceSql(value as SqlStorage);
        return sql;
      }
      if (typeof value !== 'function') {
        return value;
      }
      const method = `${scope}.${String(key)}`;
      return (...args: unknown[]) => {
        // Alarm writes inside `transaction` go through the transaction object.
        const forwarded =
          key === 'transaction' && typeof args[0] === 'function'
            ? [
                (transaction: object) =>
                  (args[0] as (transaction: object) => unknown)(
                    proxyStorage(transaction, 'transaction')
                  ),
                ...args.slice(1),
              ]
            : args;
        return traceCall('storage', { method, args: loggableArgs(args) }, () =>
          Reflect.apply(value, target, forwarded)
        );
      };
    },
  });
};

const tracedStorage = new WeakMap<object, object>();
const storageProxies = new WeakSet<object>();

/**
 * In dev mode, returns a view of Durable Object storage that logs every SQL
 * statement, transaction, and alarm read or write. Outside dev mode, returns
 * the storage unchanged. Idempotent, so helpers sharing one storage log each
 * call once.
 */
export const traceStorage = <Storage extends object>(
  storage: Storage
): Storage => {
  if (!devMode || storageProxies.has(storage)) {
    return storage;
  }
  const existing = tracedStorage.get(storage);
  if (existing) {
    return existing as Storage;
  }
  const traced = proxyStorage(storage, 'storage');
  tracedStorage.set(storage, traced);
  storageProxies.add(traced);
  return traced;
};
