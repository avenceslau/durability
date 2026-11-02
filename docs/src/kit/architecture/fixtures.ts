// The model directly, without the kit's React components, so the routing tests can load these diagrams in Node.
import { type ArchitectureDefinition, defineArchitecture } from "./model.ts"

/** The Workflows control plane, from a create request down to the engines that run each instance. */
const controlPlaneDefinition: ArchitectureDefinition = {
  canvas: {
    width: 1600,
    height: 676,
  },
  routing: "auto",
  flows: {
    create: {
      label: "create instance",
      color: "blue",
    },
    list: {
      label: "list instances",
      color: "red",
    },
  },
  nodes: {
    client: {
      label: "Client",
      icon: "user",
      row: 0,
    },
    controller: {
      label: "Config Controller",
      sublabel: "API / Binding",
      icon: "workers",
      row: 0,
    },
    userWorker: {
      label: "User Worker",
      icon: "workers",
      tone: "external",
      row: 0,
    },
    limiter: {
      label: "Limiter",
      icon: "shield",
      contains: ["rateLimit", "bouncer"],
      collapsed: true,
      row: 0,
    },
    rateLimit: {
      label: "RateLimiting",
      icon: "shield",
      row: 0,
    },
    bouncer: {
      label: "Bouncer",
      icon: "durable-objects",
      row: 0,
    },
    engineInstance: {
      label: "Engine",
      sublabel: "Instance",
      icon: "durable-objects",
      row: 0,
    },
    account: {
      label: "Account",
      sublabel: "Gatekeeper",
      icon: "durable-objects",
      below: "bouncer",
    },
    souschef: {
      label: "SousChef",
      icon: "durable-objects",
      replicas: 3,
      below: "engineInstance",
    },
    terminator: {
      label: "Terminator",
      icon: "trash",
      below: "account",
    },
    watchdog: {
      label: "Watchdog",
      icon: "clock",
      below: "souschef",
    },
    engine1: {
      label: "Engine",
      icon: "durable-objects",
      replicas: 2,
      row: 1,
    },
    engine2: {
      label: "Engine",
      icon: "durable-objects",
      replicas: 2,
      row: 2,
    },
    engine3: {
      label: "Engine",
      icon: "durable-objects",
      replicas: 2,
      row: 3,
    },
    waker: {
      label: "Waker",
      icon: "durable-objects",
      replicas: 2,
      below: "engine3",
    },
    storage: {
      label: "Storage",
      sublabel: "SRS · CRDB",
      icon: "database",
      below: "terminator",
    },
  },
  edges: [
    {
      from: "client",
      to: "controller",
      label: "create instance",
      flow: "create",
    },
    {
      id: "listRequest",
      from: "client",
      to: "controller",
      label: "list instances",
      flow: "list",
      stage: 5,
    },
    {
      from: "controller",
      to: "client",
      label: "list + cursor\n(timestamp)",
      flow: "list",
      back: true,
      stage: 5,
    },
    {
      from: "controller",
      to: "engineInstance",
      flow: "create",
    },
    {
      from: "controller",
      to: "rateLimit",
      flow: "create",
    },
    {
      from: "rateLimit",
      to: "bouncer",
      label: "account + workflowId",
      flow: "create",
    },
    {
      from: "bouncer",
      to: "engineInstance",
      label: "account + workflow\n+ instance ids",
      flow: "create",
    },
    {
      from: "engineInstance",
      to: "userWorker",
      label: "target.run(event,\nstubStep)",
    },
    {
      from: "engineInstance",
      to: "souschef",
      label: "register",
      flow: "create",
    },
    {
      from: "souschef",
      to: "account",
      label: "ask for concurrency",
      flow: "create",
      back: true,
    },
    {
      from: "account",
      to: "souschef",
      label: "slots",
      flow: "create",
    },
    {
      from: "souschef",
      to: "engine1",
      flow: "create",
    },
    {
      from: "souschef",
      to: "engine2",
      label: "give concurrency",
      flow: "create",
    },
    {
      from: "souschef",
      to: "engine3",
      flow: "create",
    },
    {
      from: "controller",
      to: "souschef",
      flow: "list",
      stage: 5,
    },
    {
      from: "watchdog",
      to: "souschef",
      label: "get me 100\nrunning instances",
    },
    {
      from: "watchdog",
      to: "engine3",
      label: "isStuck / softRestart",
    },
    {
      from: "souschef",
      to: "terminator",
      label: "delete workflow",
    },
    {
      from: "terminator",
      to: "storage",
      label: "delete",
    },
    {
      from: "waker",
      to: "engine3",
    },
  ],
  notes: [
    {
      id: "rps",
      text: "A DO can handle about 1k rps\n(on a good day)",
      near: "rateLimit",
      side: "top",
    },
    {
      id: "srs",
      text: "SRS → SQLite\nCRDB → CockroachDB",
      near: "storage",
    },
  ],
  groups: [
    {
      id: "cp",
      label: "Workflows Control Plane",
      contains: ["controller", "limiter", "engineInstance", "account", "souschef", "watchdog", "terminator"],
    },
  ],
  stages: [
    ["client", "controller", "engineInstance", "userWorker"],
    ["+limiter", "-controller->engineInstance", "+cp"],
    ["+souschef", "+account", "+engine*"],
    ["flow:create"],
    ["+waker*", "+watchdog", "+terminator", "+storage", "+rps", "+srs"],
    ["flow:list"],
    ["focus:souschef"],
  ],
}

/** Laid out stage by stage: the hints keep the request path on the top row and the background jobs below it. */
export const controlPlane = defineArchitecture(controlPlaneDefinition)

/** The last control-plane stage, spotlighting the SousChef; shown on a slide of its own. */
export const souschefStage = controlPlane.stages.length - 1

/** One Durable Object per user and per room, each with its own SQLite storage. */
export const fanOut = defineArchitecture({
  canvas: {
    width: 1400,
    height: 620,
  },
  flows: {
    request: {
      label: "request",
      color: "orange",
    },
  },
  nodes: {
    clients: {
      label: "Browsers",
      icon: "browser",
      replicas: 3,
    },
    worker: {
      label: "Worker",
      sublabel: "routes each request",
      icon: "workers",
    },
    user: {
      label: "User",
      sublabel: "one per user",
      icon: "durable-objects",
      iconAt: "top",
      replicas: 10000,
      above: "room",
    },
    room: {
      label: "Chat room",
      sublabel: "one per room",
      icon: "durable-objects",
      iconAt: "top",
      replicas: 1000,
    },
    userStorage: {
      label: "SQLite",
      sublabel: "ctx.storage",
      icon: "database",
    },
    roomStorage: {
      label: "SQLite",
      sublabel: "ctx.storage",
      icon: "database",
    },
  },
  edges: [
    {
      from: "clients",
      to: "worker",
      label: "WebSocket",
      flow: "request",
    },
    {
      from: "worker",
      to: "user",
      label: "idFromName(userId)",
    },
    {
      from: "worker",
      to: "room",
      label: "idFromName(roomId)",
      flow: "request",
    },
    {
      from: "room",
      to: "user",
      label: "notify",
    },
    {
      from: "user",
      to: "userStorage",
    },
    {
      from: "room",
      to: "roomStorage",
      flow: "request",
    },
  ],
  notes: [
    {
      id: "single",
      text: "Each object runs one request at a time,\nnext to its own storage",
      near: "worker",
    },
  ],
  stages: [
    ["clients", "worker"],
    ["+room"],
    ["+user"],
    ["+userStorage", "+roomStorage", "+single"],
    ["flow:request"],
  ],
})

/** One release of the engine to the next: the Engine is replaced by Engine v2, and waking splits out of it. */
export const engineVersions = defineArchitecture({
  canvas: {
    width: 1600,
    height: 560,
  },
  flows: {
    run: {
      label: "run an instance",
      color: "blue",
    },
  },
  nodes: {
    controller: {
      label: "Config Controller",
      icon: "workers",
    },
    engine: {
      label: "Engine",
      sublabel: "runs and wakes instances",
      icon: "durable-objects",
    },
    engineV2: {
      label: "Engine v2",
      sublabel: "runs instances",
      icon: "durable-objects",
      replaces: "engine",
    },
    waker: {
      label: "Waker",
      sublabel: "alarms",
      icon: "clock",
      replaces: "engine",
      below: "engineV2",
    },
    storage: {
      label: "Storage",
      sublabel: "CockroachDB",
      icon: "database",
    },
  },
  edges: [
    {
      from: "controller",
      to: "engine",
      label: "create",
      flow: "run",
    },
    {
      from: "engine",
      to: "storage",
      label: "state",
    },
    {
      from: "controller",
      to: "engineV2",
      label: "create",
      flow: "run",
    },
    {
      from: "waker",
      to: "engineV2",
      label: "wake",
    },
    {
      from: "engineV2",
      to: "storage",
      label: "state",
    },
  ],
  stages: [
    ["controller", "engine", "storage"],
    [
      "-engine",
      "+engineV2",
      "+waker",
      {
        set: {
          storage: {
            sublabel: "SQLite in each object",
            replicas: 4,
          },
        },
      },
    ],
    ["flow:run"],
  ],
})
