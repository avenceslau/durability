# Durability

Composable capabilities for application-owned Cloudflare Durable Objects:

- **`Durability`** — effectively-once operations with retries, idempotency, and result lookup.
- **`DurabilityAlarms`** — named logical alarms with retries and stable idempotency keys.
- **`DurabilityFanout`** — durable batch acceptance and independent delivery to static consumer or storage targets.
- **`DurabilityOutbox`** _(experimental, `durability/experimental`)_ — keyed latest-state publication: stage the newest value for a key with the state it describes, and it is republished until acknowledged.
- **`DurabilitySemaphore`** — one concurrency limit shared by many client Durable Objects (`durability/semaphore`), allocated in arrival-ordered rounds with cumulative claim/release accounting.
- **`DurabilityRouting`** — a DO-side load observer and client-side shard selector (`durability/routing`), supporting location hints and caller transforms.
- **`DurabilitySocket`** — typed WebSocket RPC and replayable event push from a Durable Object to browsers (`durability/socket`), with a dependency-free browser client (`durability/client`).
- **`DurabilityTracker`** _(experimental, `durability/experimental`)_ — lists work across capabilities and custom sources, as RPC handles that can be waited on or as plain records.

Durable capabilities own their storage and migrations. Routing observations are in-memory and advisory. When an object composes durable capabilities, one `DurabilityScheduler` shares its physical alarm and concurrency pool. No queue factory, generated DO class, or special consumer superclass is required.

Durability is not an event-sourcing, replay-log, or workflow-orchestration engine. Operation methods return `Promise<void>` after registration commits; they do not wait for the handler result. Failed work is retried from later alarms. Only SQLite-backed Durable Object classes are supported.

## Migrating to v3

The factory API is replaced by classes:

| v2                                                       | v3                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `createDurability(ctx, handlers, options)`               | `new Durability({ context: ctx, handlers, ...options })`           |
| `options.alarms` / `options.alarmMethods`                | `new DurabilityAlarms({ context: ctx, handlers, methods })`        |
| `durability.alarm.cleanup(time)`                         | `alarms.cleanup(time)`                                             |
| `migrateDurability(ctx, target)`                         | `Durability.migrate` / `DurabilityAlarms.migrate`                  |
| `durabilityMigrations`                                   | `durabilityOperationMigrations` / `durabilityNamedAlarmMigrations` |
| `purgeBefore(ts)` → `{ operations, namedAlarms, total }` | `purgeBefore(ts)` → `number` per helper                            |

Existing SQLite databases are upgraded transparently on first construction: no schema statement runs, the history table gains `capability` and `down` columns, and per-capability rows are recorded next to the combined v2 `durability_0004_generation_and_created_at` row. That row is kept so a rollback to 2.x also sees a complete history. Objects first created on 3.x with only one helper cannot be rolled back to 2.x, which expects both tables. `workers-qb` is no longer a dependency. The `alarmConcurrency` pool is now shared through a `DurabilityScheduler` when both helpers are used; standalone helpers each own a pool.

## Durable operations

```ts
import { DurableObject } from 'cloudflare:workers';
import { Durability, type DurableCall } from 'durability';

type ResizeInput = { imageId: string };

export class ImageJobs extends DurableObject<Env> {
  private readonly durability = new Durability({
    context: this.ctx,
    handlers: {
      resizeImage: async ({ id, payload }: DurableCall<ResizeInput>) =>
        this.env.IMAGES.resize(payload.imageId, { idempotencyKey: id }),
    },
    retries: { maxAttempts: 3 },
    methods: { resizeImage: { attemptTimeoutMs: 60_000 } },
  });

  resize(imageId: string) {
    return this.durability.resizeImage({
      id: `resize:${imageId}`,
      payload: { imageId },
    });
  }

  result(imageId: string) {
    return this.durability.resizeImage.getResult(`resize:${imageId}`);
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }
}
```

Every handler becomes a method on the instance. Handler names that collide with instance members (`alarm`, `purgeBefore`) are rejected at construction.

### Reading results

```ts
const result = await this.durability.resizeImage.getResult(`resize:${imageId}`);

switch (result.status) {
  case 'not_found':
    break;
  case 'pending':
    console.log(result.attempt, result.nextAttemptAt, result.lastError);
    break;
  case 'failed':
    console.error(result.error.name, result.error.message);
    break;
  case 'completed':
    console.log(result.result);
    break;
}
```

The completed result type is inferred from the handler. Looking up a key that belongs to another operation throws `DuplicateDurableCallError`. Payloads and results must be JSON-serializable; as with `JSON.stringify`, `undefined` properties are dropped and `undefined` array elements become `null`.

An ID stays bound to its operation and payload. Registering it again with the same operation and the same data (object key order does not matter; array order and values do) is a no-op, which is what makes retries safe. Registering it with another operation throws `DuplicateDurableCallError`, and with a different payload `DuplicateDurablePayloadError`, instead of silently dropping the new call.

## Named alarms

```ts
import { DurableObject } from 'cloudflare:workers';
import { DurabilityAlarms } from 'durability';

export class Subscription extends DurableObject<Env> {
  private readonly alarms = new DurabilityAlarms({
    context: this.ctx,
    handlers: {
      renew: async ({ idempotencyKey, signal }) => {
        await this.env.BILLING.fetch('https://billing.internal/renew', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          signal,
        });
      },
    },
    methods: { renew: { retryTimeouts: true, retries: { maxAttempts: 5 } } },
  });

  scheduleRenewal(at: number) {
    return this.alarms.renew(at);
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.alarms.alarm(info);
  }
}
```

Scheduling a name again replaces its pending occurrence. If that name is already running, the current handler continues and the replacement runs afterward. Different names may run concurrently, but one name never has more than one active handler in the same instance.

Named alarms inside the scheduler's `alarmMinDelayMs` window start from an in-memory timer at their requested time. The option accepts 1 to 15 seconds and defaults to 15 seconds; the scheduler never sets the physical alarm sooner than that delay; the physical alarm remains as a durable fallback for restarts. If concurrency capacity is full when the timer fires, execution waits in the shared FIFO queue. The scheduling method resolves after persistence and never waits for the handler to finish.

Each occurrence receives a new internal generation. Its `idempotencyKey` stays stable across retries while `attempt` increments. A successful handler removes only the occurrence it executed, so it cannot delete a replacement scheduled while it was running.

A timeout aborts the handler's `signal` and is terminal by default because the external outcome is unknown. Set `retryTimeouts: true` only when the handler's side effects use the idempotency key or reconcile their outcome before retrying. Named alarms remain at-least-once across eviction or restart.

## Using both in one Durable Object

A Durable Object has one physical alarm. When one object uses both helpers, create a `DurabilityScheduler` and pass it to each so they share the alarm, the storage, and the concurrency pool:

```ts
import { Durability, DurabilityAlarms, DurabilityScheduler } from 'durability';

export class ImageJobs extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({
    context: this.ctx,
    alarmConcurrency: 10,
    alarmMinDelayMs: 15_000,
  });

  private readonly durability = new Durability({
    scheduler: this.scheduler,
    handlers: {
      resizeImage: async ({ payload }) =>
        this.env.IMAGES.resize(payload.imageId),
    },
  });

  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: { cleanup: async () => this.env.IMAGES.cleanup() },
  });

  alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}
```

A helper configured with `context` instead of `scheduler` creates a private scheduler and accepts the scheduler options (`alarmConcurrency`, `alarmMinDelayMs`, `alarmHandoffMs`) in the same object. Two helpers on the same object must share one scheduler; otherwise each would reconcile the physical alarm against only its own records.

## Storage

Durability stores its records in the object's SQLite database. Configure the Durable Object class with `new_sqlite_classes`:

```jsonc
{
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ImageJobs"] }],
}
```

`Durability` creates and migrates `durability_calls`; `DurabilityAlarms` does the same for `durability_alarms`. Both histories are tracked in the shared `durability_migrations` table and only the constructed helpers' tables exist.

### Explicit migrations

Rollbacks are explicit because reverting the initial migration deletes records:

```ts
import { Durability, DurabilityAlarms } from 'durability';

Durability.migrate(this.ctx, 'durability_0001_create_calls');
Durability.migrate(this.ctx, null); // remove the operations schema entirely
DurabilityAlarms.migrate(this.ctx, null); // remove the named alarm schema
```

Passing a name moves that capability's schema to exactly that version. Each batch of migrations applies or reverts in one synchronous transaction, so a failure leaves the schema untouched.

Every history row stores its migration's `down` script. If a Durable Object later runs an older `durability` version, that version reverts the migrations it does not recognize using the stored scripts, so downgrades are safe without code changes. To guard against deploying a very old version by mistake, at most two unknown migrations are reverted; beyond that, construction throws. The `durability_migrations` table is dropped once no durability history remains.

## Retries, timeouts, and terminal failures

Attempts use exponential backoff with equal jitter, stop after five attempts, and time out after five minutes by default. The retry `delay` function fully controls scheduling and can be overridden globally or per method on either helper:

```ts
import { exponential, jitter } from 'durability/utils';

const durability = new Durability({
  context: this.ctx,
  handlers,
  attemptTimeoutMs: 60_000,
  retries: {
    maxAttempts: 5,
    delay: (attempt) => jitter(exponential(attempt)),
  },
  methods: {
    resizeImage: {
      attemptTimeoutMs: 10 * 60_000,
      retries: {
        maxAttempts: 2,
        delay: (attempt) => exponential(attempt, 500, 30_000),
      },
    },
  },
});
```

Each attempt receives its own `AbortSignal`. A timed-out operation follows the normal retry policy; a timed-out named alarm is terminal unless `retryTimeouts` is set. If a handler ignores abort, its in-memory lock and concurrency permit remain held until it actually settles, so a same-isolate retry cannot overlap it.

Throw `NonRetryableError` to move work directly to `failed` without another attempt. Errors named `NonRetryableError` from other packages, such as `cloudflare:workflows`, are recognized too.

## Delivery semantics and concurrency

Work is delivered at least once. A process can stop after a side effect succeeds but before its completion record commits, so handlers should be idempotent and pass the call ID or alarm `idempotencyKey` to external services.

`alarmConcurrency` defaults to 10 and is one FIFO limit shared by eager operation handlers, timer-driven work, and physical-alarm work attached to the same scheduler. Newly registered operations start eagerly only when a permit is immediately available. Work due before the physical-alarm minimum enters the same queue when its in-memory timer fires.

Completion records are retained indefinitely so IDs remain deduplicated. The scheduler owns the Durable Object's alarm; compose unrelated scheduled work as named alarms instead of replacing the physical alarm.

## Destructive retention purge

`purgeBefore(timestamp)` on either helper deletes that helper's records created strictly before `timestamp`, regardless of status, and returns the count. Records created exactly at the cutoff are retained.

```ts
const removedOperations = await this.durability.purgeBefore(retentionCutoff);
const removedAlarms = await this.alarms.purgeBefore(retentionCutoff);
```

The purge runs in one transaction. It best-effort aborts matching active handlers, but cannot force an abort-ignoring handler to stop. Operation IDs can be reused immediately; a late old generation cannot overwrite the replacement record.

## Lifecycle metrics hook

Each helper accepts `onLifecycleEvent`, which receives compact events for registration or scheduling, attempt start and settlement, pre-invocation attempt exhaustion, and purges:

```ts
const durability = new Durability({
  context: this.ctx,
  handlers,
  onLifecycleEvent: (event) => recordDurabilityMetric(event),
});
```

The hook is best-effort and non-blocking, is not a durable journal, and may duplicate or drop events across crashes. Hook failures are reported to `console.error` and never change queue state. Returned promises are attached to `waitUntil` when the context exposes it.

Further hooks attach after construction with `lifecycle(hook)`, which returns a function that detaches it. `Durability` hooks are typed per operation: a `completed` settlement carries the handler's `result`.

```ts
const detach = durability.lifecycle((event) => {
  if (event.type === 'attempt_settled' && event.outcome === 'completed') {
    publish(event.operation, event.result);
  }
});
```

## Browser sockets

`DurabilitySocket` lets browsers call a Durable Object and receive events from it over one hibernatable WebSocket. `inbound` handlers become callable methods on the client; `outbound` events become methods on the socket that push to every subscribed connection. Nothing outside `inbound` is reachable, and no result is broadcast unless an outbound method sends it.

```ts
import { DurableObject } from 'cloudflare:workers';
import {
  Durability,
  type DurableCall,
  type DurabilityLifecycleEvent,
} from 'durability';
import { DurabilitySocket, event, type SocketCall } from 'durability/socket';
import { z } from 'zod';

const TodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
});
type Todo = z.infer<typeof TodoSchema>;
type Metadata = { userId: string };

export class TodoList extends DurableObject<Env> {
  private readonly todos = new Map<string, Todo>();

  readonly durability = new Durability({
    context: this.ctx,
    handlers: {
      createTodo: async ({ payload }: DurableCall<Todo>) => {
        this.todos.set(payload.id, payload);
        return payload;
      },
    },
  });

  readonly socket = new DurabilitySocket({
    context: this.ctx,
    inbound: {
      // Bare handlers take no input (or `unknown` input they validate themselves).
      list: () => [...this.todos.values()],
      // Typed input requires a Standard Schema; here the handler is a durable operation.
      createTodo: {
        input: z.object({ id: z.string(), payload: TodoSchema }),
        handle: this.durability.createTodo,
      },
      toggle: {
        input: z.string(),
        handle: (id: string, call: SocketCall<Metadata>) => {
          const todo = this.todos.get(id);
          if (!todo) {
            throw new RangeError(`No todo "${id}" for ${call.metadata.userId}`);
          }
          todo.done = !todo.done;
          this.socket.updated(todo);
          return todo;
        },
      },
    },
    outbound: {
      created: event<Todo>(),
      updated: event<Todo>(),
      lifecycle: event<DurabilityLifecycleEvent>(),
    },
    metadata: (request): Metadata => ({
      userId: request.headers.get('x-user-id') ?? 'anonymous',
    }),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Push a durable operation's result to every subscriber once it has committed.
    this.durability.lifecycle((e) => {
      if (e.type === 'attempt_settled' && e.outcome === 'completed') {
        this.socket.created(e.result);
      }
    });
    this.durability.lifecycle(this.socket.lifecycle);
  }

  fetch(request: Request) {
    return this.socket.fetch(request);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    return this.socket.webSocketMessage(ws, message);
  }

  webSocketClose(ws: WebSocket) {
    this.socket.webSocketClose(ws);
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }
}

// The Worker authenticates, then forwards the upgrade with trusted metadata.
export default {
  async fetch(request: Request, env: Env) {
    const listId = new URL(request.url).pathname.split('/').pop() ?? '';
    const userId = await authenticate(request);
    if (!userId) {
      return new Response('Unauthorized', { status: 401 });
    }
    const upgrade = new Request(request, {
      headers: { ...Object.fromEntries(request.headers), 'x-user-id': userId },
    });
    return env.TODO_LISTS.getByName(listId).fetch(upgrade);
  },
};
```

An inbound handler is either a bare function, which receives no input or `unknown` input it validates itself, or `{ input, handle }`, where `input` is any [Standard Schema](https://standardschema.dev) validator (zod, Valibot, ArkType, …) and `handle` declares its parameter type. A bare function that claims a typed parameter does not compile. Handlers receive `call.metadata`, the value `metadata(request)` returned at upgrade time; it is stored in the WebSocket attachment, so it survives hibernation. The fronting Worker is responsible for authentication and for routing the upgrade to the right object; the socket does no authorization of its own. `metadata` must be assignable to every `SocketCall<…>` annotation the handlers declare.

Every outbound event is persisted to `durability_socket_events` with a sequence number before it is pushed. A reconnecting client subscribes from the last sequence it saw: events still within `retention` (default 1000) are replayed in order, otherwise the client is told to resync and should rebuild its state from an inbound snapshot call. Payloads must be JSON. Keep-alive pings are answered by the runtime through `setWebSocketAutoResponse`, so idle connections never wake the object. Frames over 1 MiB are rejected; malformed frames close the connection with code `4002`.

The browser client derives every method and event type from the socket:

```ts
import { DurabilitySocketClient, logging } from 'durability/client';
import type { TodoList } from '../worker'; // type-only: nothing from the Worker is bundled

const client = new DurabilitySocketClient<TodoList['socket']>({
  url: (listId) => `wss://example.com/lists/${listId}/ws`,
}).with(logging());

const conn = client.connect('personal');
const todos = await conn.rpc.list();
await conn.rpc.createTodo({
  id: crypto.randomUUID(),
  payload: { id: 'todo-1', title: 'Ship it', done: false },
});
await conn.rpc.toggle('todo-1');

conn.on.updated((todo) => render(todo));
conn.on.lifecycle((e) => {
  if (e.entityKind === 'operation' && e.type === 'attempt_settled') {
    markSettled(e.id);
  }
});
conn.on.resync(({ names }) => reload(names)); // first subscription, and after an unreplayable gap
conn.on.status((status) => showStatus(status)); // connecting | connected | disconnected | closed
conn.close();
```

`on.resync` reports the outbound events whose subscribers have no continuous history: every mapped name on their first subscription, newly added names on a live connection, and all names after an unreplayable gap. Rebuild the affected state from an inbound snapshot call; `@durability/tanstack-db` does this for collections.

Connections open lazily on the first call or subscription and reconnect with jittered exponential backoff. Calls queued before the socket opens are sent once; calls already sent when the connection drops reject with `SocketConnectionLostError` and are never replayed, because the server may have run them. Route retried mutations through `Durability` with a stable idempotency key rather than re-calling. Calls reject with `SocketTimeoutError` after `timeoutMs` (default 2 minutes). Server-side handler failures reject with `SocketRemoteError`, carrying the server error's `name` and `message`. `with(transform)` returns a new client that wraps every call; transforms receive `{ method, input, next }` and may replace the input.

`durability/client` imports nothing from `cloudflare:workers` and is typechecked against DOM types only. The complete, typechecked version of this example lives in [`examples/realtime-todos`](../../examples/realtime-todos).

## Tracking work (experimental)

Everything under `durability/experimental` may change or be removed in a minor release and is excluded from the semver guarantee of the root package. Pin an exact version when depending on it. Nothing from this entry point is reachable from `durability`, and it adds nothing to the public types of `Durability` or `DurabilityAlarms`.

`DurabilityTracker` lists records from several sources. Sources are keyed by names you choose; the key becomes each record's `source`.

```ts
import { DurabilityTracker } from 'durability/experimental';

export class ImageJobs extends DurableObject<Env> {
  // scheduler, durability, and alarms as above

  private readonly tracker = new DurabilityTracker({
    sources: { jobs: this.durability, alarms: this.alarms },
  });

  listWork(cursor?: string) {
    return this.tracker.list({ status: 'pending', limit: 50, cursor });
  }

  getWork(id: string) {
    return this.tracker.get('jobs', id);
  }
}
```

All three methods take the same query: `{ source, name, status, limit, cursor }`. `limit` defaults to 50 and is capped at 100. Pass `cursor` back with the same query to continue; it is present only while more records may follow. Sources are read one after another, so there is no ordering across sources.

- `list(query)` returns `{ items, cursor }`. Each item has `source`, `id`, `name`, `generation`, `createdAt`, and `state`, plus `get()`, which reads the latest state, and `wait({ timeoutMs })`, which resolves once the record is `completed` or `failed`, or returns the latest state after the timeout without polling storage. Both return `not_found` once the record is purged or its ID is reused for new work.
- `get(source, id)` returns one such handle, or `undefined`.
- `records(query)` returns `{ records, cursor }` with the same data and no functions.

Narrowing on `source` and `name` narrows `state.result` to that handler's result type.

### Handles over RPC

Return handles from a Durable Object method. Over Workers RPC or [Cap'n Web](https://github.com/cloudflare/capnweb), the data fields are copied and `get` and `wait` become stubs, so a caller can wait without polling:

```ts
const { items } = await env.IMAGE_JOBS.getByName('jobs').listWork();
for (const item of items) {
  const result = await item.wait({ timeoutMs: 30_000 });
}
```

Workers RPC pipelining also lets a caller wait in the same round trip that returns the handle, for example `stub.getWork(id).wait({ timeoutMs })` when the method always returns a handle. Waiting is in memory: if a deployment, eviction, or disconnect interrupts it, get a new handle by ID and wait again. Stubs follow the RPC system's disposal rules; dispose them with `using` or let the request end.

### Records over sockets

`DurabilitySocket` frames are JSON, so functions do not survive the trip. Expose `records` as an inbound snapshot and push changes as outbound events, for example from a lifecycle hook:

```ts
readonly socket = new DurabilitySocket({
  context: this.ctx,
  inbound: {
    work: {
      input: z.object({ cursor: z.string().optional() }),
      handle: (query: { cursor?: string }) => this.tracker.records(query),
    },
  },
  outbound: { settled: event<DurabilityOperationEvent<typeof handlers>>() },
});
```

A complete two-object version, with push through `DurabilityFanout` and request/response through a pipelined `wait`, lives in [`examples/job-dashboard`](../../examples/job-dashboard).

### Sources

`Durability` lists every operation. `DurabilityAlarms` lists pending and failed occurrences only, because success deletes an occurrence; a waiter still sees `completed`. Rescheduling an alarm replaces its occurrence, so waiters on the old one receive `not_found`.

Any object implementing `TrackedSource` can be a source, for example work kept in the application's own table:

```ts
import type { TrackedSource } from 'durability/experimental';

type Approvals = { approval: { approvedBy: string } };

const approvals: TrackedSource<Approvals> = {
  get: async (id) => readApproval(id),
  list: async ({ limit, cursor, status, name }) =>
    listApprovals(limit, cursor, status, name),
  watch: (id, listener) => subscribeToApproval(id, listener),
};

new DurabilityTracker({ sources: { jobs: this.durability, approvals } });
```

- `get(id)` and `list(query)` return records with `id`, `name`, `generation`, `createdAt`, and `state`. Keep `generation` stable unless the ID is reused for new work.
- `state.status` is `pending`, `completed`, or `failed`. Express finer outcomes, such as a rejection, as `failed` with a specific `error.name`.
- `list` may return fewer than `limit` records together with a cursor. Omit the cursor at the end.
- `watch(id, listener)` is optional and returns an unsubscribe function. Call `listener()` after a record may have settled; pass the settled record when it can no longer be read. Without `watch`, `wait` reads again only at its timeout.

New members of `TrackedSource` are always optional, so a custom source keeps compiling across releases.

## Semaphore

`DurabilitySemaphore` holds one concurrency limit — say, an account's maximum running jobs — inside an application-owned Durable Object, and hands permits to many client Durable Objects that queue work. Requests arriving within a round are allocated together in arrival order, so the oldest queued work across all clients is admitted first. Groups (a workflow, a tenant) may carry their own ceiling under the shared limit.

```ts
import { DurableObject } from 'cloudflare:workers';
import { timeout } from '@durability/transforms';
import { DurabilityScheduler } from 'durability';
import {
  DurabilitySemaphore,
  type SemaphoreRequest,
} from 'durability/semaphore';

/** One instance per account; the account id is the semaphore key. */
export class AccountLimit extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly semaphore = new DurabilitySemaphore({
    scheduler: this.scheduler,
    limit: () => this.env.ACCOUNT_CONCURRENCY,
    groupLimit: (workflowId) => this.workflowLimits.get(workflowId),
  });

  permits(message: SemaphoreRequest) {
    return this.semaphore.handle(message);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export const limits = DurabilitySemaphore.client({
  target: AccountLimit, // Vite injects exportName
  invoke: (stub, message) => stub.permits(message),
});

// From a client Durable Object:
const grant = await limits.with(timeout, 5_000).request(accountId, {
  type: 'request',
  v: 1,
  clientId: this.ctx.id.toString(),
  demand: [{ group: workflowId, count: queued, oldestAt: oldestEnqueuedAt }],
  grants: [{ grantId, claimed: 3, released: 1 }], // cumulative reports
});
```

- **Rounds.** `handle()` holds a request for up to `roundWaitMs` (default 1 second) so concurrent requests are allocated together, and runs rounds no closer than `roundPeriodMs` (default 2 seconds). The response's `nextRequestAt` tells the client when it may ask again.
- **Grants and reports.** Each `(client, group)` that receives permits gets a grant. Clients report `claimed` (permits actually used) and `released` (claimed permits returned) per grant as cumulative high-water marks, piggybacked on requests or sent with a `sync` message. Counts only move forward and are clamped to the grant, so lost, repeated, or reordered reports can never free capacity twice. Permits a client never claims within `grantTimeoutMs` (default 10 seconds) are reclaimed; a later claim is answered with the clamped count and `status: 'expired'`.
- **Blocked attribution.** Demand that stays queued is explained per group: `group_limit`, `limit`, `not_permitted` (`canGrant` returned false), or `limit_resolution_error` (`groupLimit` threw; the group fails closed).
- **Limits are live.** `limit` and `groupLimit` are resolved once per round. Lowering a limit never evicts running work; it stops new admissions until usage is below the new ceiling.
- **Client side.** `DurabilitySemaphore.client()` has the same shape as `DurabilityRouting.client()`: the Vite plugin injects `exportName`, `namespace` is the escape hatch, and caller transforms such as `timeout` compose. The underlying `SemaphoreClient` is transport-independent and remembers each key's `nextRequestAt`. A queueing client helper that drives this protocol is planned; today the client Durable Object owns its queue.

`usage()` reports the limit, outstanding permits, and per-group usage. `DurabilitySemaphore.migrate(this.ctx, null)` removes the schema.

## Routing and fanout

A queue is a composition, not another exported abstraction. An application owns its DO class and attaches the capabilities it needs:

```ts
import { DurableObject } from 'cloudflare:workers';
import {
  DurabilityFanout,
  DurabilityScheduler,
  type FanoutInput,
  type StoredMessage,
} from 'durability';
import { DurabilityRouting } from 'durability/routing';

export class Mailbox extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly routing = new DurabilityRouting();
  private readonly fanout = new DurabilityFanout<Job>({
    scheduler: this.scheduler,
    routing: this.routing,
    targets: {
      consumer: { deliver: (messages) => this.env.CONSUMER.consume(messages) },
      archive: { storage: (message) => this.store('archive/', message) },
    },
    dlq: (message) => this.store('dead-letters/', message),
  });

  private async store(prefix: string, message: StoredMessage<Job>) {
    await this.env.ARCHIVE.put(
      `${prefix}${encodeURIComponent(message.id)}`,
      JSON.stringify(message),
      { onlyIf: { etagDoesNotMatch: '*' } }
    );
  }

  enqueue(messages: FanoutInput<Job>[]) {
    return this.fanout.enqueue(messages);
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

const routing = DurabilityRouting.client({
  target: Mailbox,
  invoke: (stub, messages: FanoutInput<Job>[]) => stub.enqueue(messages),
  sharding: (messages, context: { tenant?: string } | undefined) => ({
    shard: context?.tenant ?? messages[0]?.body.customerId ?? 'default',
    locationHint: 'weur',
  }),
});

const result = await routing.push([{ id: 'job:42', body: job }], {
  tenant: 'acme',
});
```

The application chooses the RPC method via `invoke`; routing does not know about messages or fanout. A single push selects one shard for the entire input. Static fanout target IDs identify independent delivery obligations; each accepted message snapshots its recipients. Targets added later do not receive old work, and a removed target's work remains durable with an error and backoff until that ID is restored. Target callbacks/storage references are fixed at capability construction.

### Acceptance, not completion

`fanout.enqueue` accepts a message or batch and returns:

```ts
type EnqueueResult<T> =
  | { success: true; value: T; load: LoadSnapshot }
  | {
      success: false;
      error: { name: string; message: string };
      load: LoadSnapshot;
    };
```

Fanout's value is the message ID array; an application RPC can return its own value with the same envelope. Success means the entire batch and its target obligations were committed, not that consumers ran. Definite validation/conflict rejection returns `success: false` with no partial batch. Storage/commit uncertainty throws, as does an RPC transport failure: the caller must not infer non-acceptance. Routing never silently retries or switches shards on a failed call. The caller decides whether to retry on the same or a different shard.

`id` defaults to a UUID. `deduplicationKey` defaults to `id`; while a registration remains active, repeating that key with identical ID, payload, and recipient set does not redeliver acknowledged siblings. Reusing it for different work rejects the batch. After the final target settles, the message manifest is removed and the key may be reused. This is not permanent or cross-shard deduplication. Consumers must make side effects idempotent for at-least-once delivery.

### Load and adaptive routing

A snapshot contains `observedAt`, `windowMs: 60000`, and:

- `inbound`: instantaneous `inFlight`, rolling `completed`, and `averageProcessingMs` for enqueue calls through acceptance/rejection.
- `outbound`: the same metrics for target delivery attempts (one batch to one target is one attempt), plus exact durable `pendingDeliveries` counting outstanding message-target pairs.

Counts and averages share a rolling window with one-second buckets. No samples means `null`, not zero; telemetry resets on eviction while backlog survives. A DO cannot measure requests waiting in the platform before its handler starts. Snapshots are advisory, not capacity reservations or global metrics.

`sharding(input, context, observations)` can inspect recent per-shard snapshots. Caller context can contain arbitrary local values; it is not persisted or sent to consumers. A location hint influences initial shard placement, not existing DO placement.

Without custom sharding, routing starts with one shard, samples two candidate shard keys, and compares backlog followed by in-flight processing pressure. It widens under backlog pressure (`softBacklogLimit`, default 1000) and narrows slowly when observations are shallow. Observations expire and are bounded per isolate; this is a best-effort adaptive router, not a globally coordinated autoscaler. Stable-key sharding gives affinity; random routing does not guarantee ordering between separate pushes.

### Independent delivery

First deliveries are ordered by enqueue sequence per shard and target. Waiting retries do not block later first deliveries; completion order is not guaranteed. Each scheduler pass advances a bounded batch per target (`maxBatchSize`, default 10) with the shared concurrency pool. Different targets progress independently subject to that capacity.

Set `batchDelayMs` to hold first deliveries for up to that many milliseconds, so messages enqueued together reach the consumer as one batch instead of one call each. Each first attempt is rounded up to the next multiple of `batchDelayMs`, so messages enqueued within the same window become due at the same time. It delays delivery, not acceptance: `enqueue` still returns once the batch commits. Retries keep their policy delay.

Consumer callbacks may forward the batch to any ordinary WorkerEntrypoint RPC method. Messages include `id`, `deliveryId`, `target`, `body`, `attempt`, `enqueuedAt`, and callable settlement capabilities:

- `ack()` settles this target only.
- `retry(10)` schedules eligibility after 10 ms, overriding the policy delay. It is not a real-time delivery guarantee.
- `deadLetter()` records durable terminal intent before writing to the DLQ. Exhaustion does the same automatically.
- Returning, throwing, or timing out leaves unsettled messages eligible for retry. A second or late settlement call rejects with `FanoutSettlementError`.

Each settlement call is an RPC back into the Durable Object plus a storage transaction. For consumers that only ever acknowledge the whole batch, set `ackOnReturn: true` on the target: when `deliver` returns without throwing, every message the consumer did not settle explicitly is acknowledged in one transaction, without a call per message. Explicit `retry()` and `deadLetter()` calls still apply, and a throw or timeout acknowledges nothing.

```ts
targets: {
  consumer: {
    deliver: (messages) => this.env.CONSUMER.consume(messages),
    ackOnReturn: true,
  },
},
batchDelayMs: 100,
```

Await settlement calls. Timed-out RPCs cannot be forcibly cancelled, so side effects may overlap later attempts. Storage targets automatically acknowledge successful writes; failed writes retry independently of consumer targets. Their write contract must be idempotent by the supplied delivery identity.

### DLQ storage and per-target redrive

Fanout only ever **writes** to storage, so a storage target and the `dlq` are both just a write function:

```ts
type MessageWrite<Body> = (message: StoredMessage<Body>) => Promise<void>;
```

No adapter class or storage interface ships with the library: R2, DO storage, D1, or an HTTP endpoint are all one callback. What separates an archive from a dead letter is the **role in the flow**, not the type — a storage target receives every message on the success path, while `dlq` receives only what a target gave up on. Both may write to the same bucket under different prefixes.

A stored entry carries `id` (unique per registration and target), `messageId`, `target`, `body`, `enqueuedAt`, `storedAt`, and `attempts`; only dead letters also carry `failure: { reason, error }`.

Two write invariants are the application's to uphold:

- **Key each entry by `id` and refuse to overwrite it.** `id` is stable across delivery attempts, so a retried write collapses onto the same entry (`onlyIf: { etagDoesNotMatch: '*' }` on R2) and a redrive deletes exactly what it re-enqueued. `attempts` and `storedAt` advance between attempts, so entries are not byte-identical.
- **Delete only after acceptance.** Reading entries back for replay or redrive is application policy, so nothing in the library lists or removes them.

Retention is likewise external: filter on `storedAt` when selecting entries to redrive, and configure a **lifecycle deletion rule** on the prefix (for example 30 days on a DLQ prefix, unbounded for an archive) for physical expiry. A failed dead-letter write retains the terminal intent with a 60-second backoff rather than redelivering to the consumer. Omitting `dlq` drops terminal deliveries: nothing could ever accept them, and retrying would keep the object awake indefinitely. The `terminal` lifecycle event still reports each one.

Redrive is explicit application code, not queue sugar. Walk your own storage, select what to replay, then enqueue only the failed target:

```ts
const result = await routing.push({
  messages: [
    { id: entry.messageId, body: entry.body, deduplicationKey: entry.id },
  ],
  options: { targets: [entry.target] },
});
if (result.success) {
  await dlq.remove(entry.id);
}
```

Here the application RPC forwards `messages` and `options` to `fanout.enqueue`. A fresh registration resets attempts; using the DLQ entry ID as the key avoids colliding with the original message's still-running siblings. Never remove an entry on rejection or transport uncertainty. A crash between re-enqueue and removal may still duplicate delivery.

### Transforms and build-time wiring

Routing uses the actual `@durability/transforms` runtime. For example, `routing.with(timeout, 5000).with(tenant, 'acme').push(input)` composes existing caller transforms. `tenant` is created with `defineTransform<RoutingSession<Input, Value, Context>, Context>().caller(...)`; context contributions shallow-merge, with transform fields overriding matching positional fields. An RPC timeout is not cancellation. Retrying a push may select a new shard, so choose stable keys when retry affinity matters.

`doTransforms` from `@durability/transforms/vite` maps `DurabilityRouting.client({ target: Mailbox, ... })` to its same-module exported class name and validates it against Wrangler. It injects `exportName`, not a generated DO or a magic application method. Without the plugin, set `exportName: 'Mailbox'` explicitly; `namespace: () => env.MAILBOXES` is an escape hatch for explicit or remote bindings.

Loopback namespaces need the application DO declared in Wrangler migrations (or the platform's supported class configuration), but no redundant DO binding block is needed. Consumer transport is explicitly wired by the application, such as a service binding or loopback entrypoint. See the typechecked [email queue composition](../../examples/email-queue).

## Outbox (experimental)

`DurabilityOutbox` is exported from `durability/experimental` and may change in a minor release; pin an exact version when depending on it.

`DurabilityOutbox` publishes the newest state of a key to something outside the object — a KV namespace, another Durable Object, an API — and keeps retrying until the sink accepts it. Use it when consumers need the latest value, not every change: restaging a key before it is published replaces the pending version, so superseded versions may never be sent. For message delivery where every message matters, use `DurabilityFanout`.

```ts
import { DurableObject } from 'cloudflare:workers';
import { DurabilityScheduler } from 'durability';
import { DurabilityOutbox } from 'durability/experimental';

type Topology = { workflowId: string; steps: string[] };

export class Account extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly topology = new DurabilityOutbox<Topology>({
    scheduler: this.scheduler,
    channel: 'topology',
    // The sink keeps the highest version it has seen per key, so a slow
    // publication of an older version can never overwrite a newer one.
    publish: async (entries) => {
      const results = await this.env.TOPOLOGY_INDEX.replace(
        entries.map(({ key, version, value }) => ({ key, version, value }))
      );
      // Returning acknowledges every entry not marked for retry.
      for (const [index, result] of results.entries()) {
        if (!result.ok) {
          entries[index]!.retry();
        }
      }
    },
  });

  async saveTopology(topology: Topology) {
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO topologies (id, body) VALUES (?, ?)',
        topology.workflowId,
        JSON.stringify(topology)
      );
      await this.topology.stage(topology.workflowId, topology);
    });
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}
```

- **Atomic with application state.** `stage()` inside `ctx.storage.transaction()` commits or rolls back with the application's writes.
- **Versions.** Every `stage()` returns a version that is monotonic across the whole object, including after acknowledged entries are deleted. Sinks must be idempotent on `(key, version)` and keep the highest version they have seen: a slow publication of an older version can land after a newer one. A plain `KV.put` cannot do this; compare versions in a Durable Object, a transactional store, or a conditional write.
- **Acknowledgement.** `publish` returning acknowledges every entry not marked with `entry.retry(delayMs?)`; throwing or exceeding `attemptTimeoutMs` (default 60 seconds) retries the whole batch. Acknowledging a version deletes the entry only if it is still the newest, so an in-flight publication can never discard a later stage.
- **Retries never give up.** Dropping the newest state would leave the sink stale forever, so there is no attempt limit or dead-letter queue; `retries.delay(attempt)` controls backoff (default: jittered exponential capped at 5 minutes).
- **Channels.** Several outboxes share one scheduler and one set of tables, partitioned by `channel` (default `default`); each owns its own `publish`, and the same key in different channels is independent. Attaching two outboxes with the same channel to one scheduler throws. Entries of a channel no outbox attaches are retained and postponed, as fanout does for a removed target.
- **Batching.** `maxBatchSize` (default 50) bounds one `publish` call. `batchDelayMs` rounds first publication up to the next multiple of the delay, so stages within one window coalesce into a batch; a stage landing exactly on a boundary is due immediately.

`DurabilityOutbox.migrate(this.ctx, null)` removes the outbox schema.

## Retained log

Fanout deletes a record once every target settles it, which is what a work queue wants. A log wants the opposite: records are **retained** so a consumer can rewind, a new consumer can start from the beginning, and several consumers can read the same history at different speeds. `DurabilityLog` is that second shape, and it attaches to the same scheduler.

```ts
import { DurabilityLog, DurabilityScheduler, type LogRecord } from 'durability';

export class Partition extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly log = new DurabilityLog<Event>({
    scheduler: this.scheduler,
    retention: {
      maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxRecords: 100_000,
      maxBytes: 512 * 1024 * 1024,
    },
    // Flushed records stay readable: `write` returns a locator the log keeps,
    // and `read` hands the segment back when a consumer asks for it.
    cold: {
      write: async ({ records, firstOffset }) => {
        const locator = `segment/${this.ctx.id}/${firstOffset}`;
        await this.env.COLD.put(locator, JSON.stringify(records), {
          onlyIf: { etagDoesNotMatch: '*' },
        });
        return locator;
      },
      read: async (locator) => {
        const stored = await this.env.COLD.get(locator);
        return stored ? await stored.json<LogRecord<Event>[]>() : undefined;
      },
    },
  });

  append(events: Event[]) {
    return this.log.append(events.map((body) => ({ body })));
  }
}
```

`append` mirrors `enqueue`: the batch commits atomically, definite input rejections return `success: false`, and storage or commit uncertainty throws. It returns each record's **offset** in input order. Passing a `key` makes an append idempotent — re-appending an existing key returns its original offset and consumes no new one — so a producer that retries after an uncertain commit does not duplicate records.

Consumers **pull** and own their position:

```ts
const from = (await log.cursor('search')) ?? (await log.bounds()).oldestOffset;
const page = await log.read({ from, limit: 100 });
await index(page.records);
await log.commit('search', page.nextOffset);
```

`commit` only ever advances, so a late or duplicated commit cannot rewind a cursor. Cursors are independent: `log.cursors()` returns every consumer's position, and `log.load()` reports the furthest-behind cursor as backlog so routing can weigh partitions by consumer lag rather than by queue depth.

### Retention is not acknowledgement

Records leave only through `trim()`, which enforces `maxAgeMs` and `maxRecords`, oldest first. Retention is deliberately not automatic, because no capability should schedule work an application did not ask for. A `DurabilityAlarms` handler is the composition that gives it a schedule, and it keeps `alarm()` a pure delegation:

```ts
private readonly alarms = new DurabilityAlarms({
  scheduler: this.scheduler,
  handlers: { compact: () => this.log.trim() },
});

alarm(info?: AlarmInvocationInfo) {
  return this.scheduler.alarm(info);
}
```

`maxBytes` is the budget that actually matters, because a Durable Object holds a hot window rather than an unbounded log. It counts payload bytes held in the object and is capped at `maxLogBytes` (1 GiB), leaving room for the other capabilities sharing that object's storage.

### Flushing to cold storage, and reading it back

Retention has two possible destinations. Without `cold`, expiring records are **deleted**. With `cold`, they are **flushed** and stay readable:

```ts
type LogColdStorage<Body> = {
  write(segment: LogSegment<Body>): Promise<string>;
  read(locator: string): Promise<LogRecord<Body>[] | undefined>;
};
```

`write` receives one contiguous run of records, oldest first, and returns a locator — any string identifying where the segment went. The log stores that locator in a durable segment index **before** deleting the records, so a crash in between leaves a written, readable segment rather than records pointing nowhere. A failed write propagates with the records still in the object, so configured storage cannot be skipped, and writes are at-least-once, so key segments by first offset and refuse to overwrite.

`read` is what makes a flush **rehydratable**. A consumer reading a flushed offset gets its records back transparently, so falling behind the hot window is no longer fatal; `bounds()` reports `oldestOffset` (oldest readable, including flushed segments) alongside `hotOffset` (lowest offset still in the object). Cold reads cost a round trip and open input gates, so they serve only consumers that fell behind — never the hot path.

External storage expires on its own schedule, so mirror a lifecycle rule with `forgetColdBefore(offset)` to drop stale index entries. Returning `undefined` from `read` is also honoured: a segment the index outlived surfaces as truncation rather than a silent gap.

Retention still **ignores cursors**, exactly as a log should: a consumer slower than everything readable loses records. It learns loudly rather than silently skipping, because reading below the oldest readable offset throws `LogTruncatedError` carrying `requestedOffset` and `oldestOffset`. Compare `bounds()` against a cursor to detect the risk before it happens.

### Leases for parallel consumers

`read` plus `commit` is enough for one worker per consumer. It is **not** enough when two pollers share a consumer name: both read the same page and both process it. Leases close that gap.

```ts
const lease = await log.lease('search', 100);
if (lease) {
  try {
    await index(lease.records);
    await log.ack('search', lease.batchId);
  } catch {
    await log.nack('search', lease.batchId);
  }
}
```

`lease` claims a range of offsets durably **before** returning the records, so a second caller gets `undefined` rather than the same offsets. `undefined` means nothing is available right now — either the consumer is at `maxParallelism` or the log has no unleased records — so treat it as a signal to back off.

A range is held until it is acked, nacked, or its lease expires after `leaseMs`. Redelivery always issues a **fresh `batchId`**, which fences the previous holder: its `ack` throws `LogLeaseError` rather than committing a range someone else now owns. Double settlement throws for the same reason.

`maxParallelism` lets one consumer hold several ranges at once, and `ack` commits only over an **unbroken run** of settled ranges starting at the cursor. Acking a later range while an earlier one is still in flight advances nothing, so parallelism never skips offsets. Leases are durable, so eviction mid-flight does not release a range early, and a range that retention flushed while it was held is rehydrated on redelivery.

A range that keeps failing would be redelivered forever. `maxAttempts` bounds that, but only together with `onPoison`: without somewhere to send the records, blocking the consumer beats silently dropping them. With both set, an exhausted range is marked skipped — durably, before the callback runs, so a failing handler cannot resurrect it — and the commit then runs over it like an acked one.

Leases are opt-in. Without the `leases` option no lease tables are created, `read`/`commit` behave exactly as before, and the lease methods throw.

### What it is not

There is no per-record retry, timeout, or dead letter here: a log tracks positions, not attempts. When a single record must be retried independently of its neighbours, that is fanout's job, and the two compose on one object.

There is also no key compaction. `deduplicationKey` is unique per retained record, which is the opposite of a compaction key, and deduplication lasts only while the original record is retained — re-appending a key after its record was flushed or deleted creates a new record.

## When a run cannot finish

A Durable Object alarm whose handler throws is retried with backoff a limited number of times and then dropped. Every helper's `alarm()` ends by reconciling the physical alarm, and a storage error there would otherwise propagate, so enough of them in a row would leave pending work with nothing armed. Instead, a run that fails arms the physical alarm directly at `alarmMinDelayMs` from now and returns, reporting `durability.alarm.failed` with the error; the next run reconciles properly. Only when even that `setAlarm` fails does the failure reach the platform and its retries.

## Long-running alarm calls

Alarm invocations have a 15-minute wall-time limit. If work is still pending after `alarmHandoffMs` (default 14 minutes), the scheduler retains its promise in memory, arms a fallback after `alarmMinDelayMs`, and returns from the current invocation. The next alarm attaches to the same promise instead of starting the handler again. If the object is evicted during a handoff, the next alarm reconstructs and executes the persisted pending work.
