import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_TIMING, type Frame, frameAt, frameOf, planTransition, sceneOfFrame } from "./choreography.ts"
import { edgeGeometry, nodeRect } from "./layout.ts"
import { type ArchitectureDefinition, type ArchitectureDiagram, defineArchitecture, type StageState } from "./model.ts"

const definition: ArchitectureDefinition = {
  canvas: {
    width: 1600,
    height: 700,
  },
  flows: {
    main: {
      label: "main",
      color: "blue",
    },
  },
  nodes: {
    client: {
      label: "Client",
    },
    api: {
      label: "API",
    },
    engine: {
      label: "Engine",
    },
    engineV2: {
      label: "Engine v2",
      replaces: "engine",
    },
    waker: {
      label: "Waker",
      replaces: "engine",
    },
    store: {
      label: "Store",
    },
  },
  edges: [
    {
      from: "client",
      to: "api",
      flow: "main",
    },
    {
      from: "api",
      to: "engine",
    },
    {
      from: "api",
      to: "engineV2",
    },
    {
      from: "waker",
      to: "engineV2",
    },
    {
      from: "engine",
      to: "store",
    },
  ],
  notes: [
    {
      id: "tip",
      text: "Tip",
      near: "store",
    },
  ],
  stages: [
    ["client", "api"],
    ["engine", "store", "tip"],
    ["flow:main"],
    [{ set: { store: { label: "Store v2", replicas: 3 } } }],
    ["-engine", "+engineV2", "+waker"],
  ],
}

const diagram = defineArchitecture(definition)

function stage(index: number, from: ArchitectureDiagram = diagram): StageState {
  const state = from.stages[index]
  assert.ok(state !== undefined)
  return state
}

function sorted(ids: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...ids].sort()
}

test("adding nodes moves the old ones, then shows the new ones, then draws their edges", () => {
  const plan = planTransition(diagram, stage(0), stage(1))

  assert.deepEqual(sorted(plan.move), ["api", "client"])
  assert.deepEqual(sorted(plan.appear), ["engine", "store", "tip"])
  assert.deepEqual(sorted(plan.draw), ["api->engine", "engine->store"])
  assert.deepEqual(plan.keep, ["client->api"])
  assert.deepEqual([plan.retract, plan.disappear, plan.change, plan.morph], [[], [], [], []])

  const { move, appear, draw } = plan.windows
  assert.equal(move.start, 0)
  assert.equal(appear.start, move.start + move.duration)
  assert.equal(draw.start, appear.start + appear.duration)
  assert.equal(plan.duration, draw.start + draw.duration)
  assert.ok((plan.delays.get("store") ?? 0) > (plan.delays.get("engine") ?? 0), "later ranks appear later")
})

test("going back plays the reverse: edges retract, nodes fade, then the rest move", () => {
  const plan = planTransition(diagram, stage(1), stage(0))

  assert.deepEqual(sorted(plan.retract), ["api->engine", "engine->store"])
  assert.deepEqual(sorted(plan.disappear), ["engine", "store", "tip"])
  assert.deepEqual(sorted(plan.move), ["api", "client"])
  assert.deepEqual([plan.appear, plan.draw], [[], []])

  const { retract, disappear, move } = plan.windows
  assert.equal(retract.start, 0)
  assert.equal(disappear.start, retract.duration)
  assert.equal(move.start, disappear.start + disappear.duration)
})

test("a spotlight changes nothing on the layout, so there is nothing to play", () => {
  const plan = planTransition(diagram, stage(1), stage(2))

  assert.equal(plan.duration, 0)
  assert.deepEqual([plan.move, plan.appear, plan.draw, plan.retract], [[], [], [], []])
})

test("a set token is a change in place, played with the moves", () => {
  const plan = planTransition(diagram, stage(2), stage(3))

  assert.deepEqual(plan.change, ["store"])
  assert.ok(plan.move.includes("store"), "the longer label resizes the node")
  assert.deepEqual(plan.appear, [])
  assert.equal(plan.windows.move.duration, DEFAULT_TIMING.move)
})

test("replaces turns a swap into a morph, both ways", () => {
  const forward = planTransition(diagram, stage(3), stage(4))

  assert.deepEqual(forward.morph, [
    { from: "engine", to: "engineV2" },
    { from: "engine", to: "waker" },
  ])
  assert.ok(!forward.appear.includes("engineV2") && !forward.disappear.includes("engine"))
  assert.deepEqual(sorted(forward.retract), ["api->engine", "engine->store"])
  assert.deepEqual(sorted(forward.draw), ["api->engineV2", "waker->engineV2"])

  const backward = planTransition(diagram, stage(4), stage(3))
  assert.deepEqual(backward.morph, [
    { from: "engineV2", to: "engine" },
    { from: "waker", to: "engine" },
  ])
})

test("frames run from the start state to the target, phase by phase", () => {
  const from = stage(0)
  const to = stage(1)
  const plan = planTransition(diagram, from, to)
  const start = frameOf(diagram, from)
  const at = (t: number): Frame => frameAt(start, to, plan, t)

  assert.deepEqual(at(0).nodes.get("api")?.center, start.nodes.get("api")?.center)
  assert.deepEqual(at(plan.duration).nodes.get("api")?.center, to.layout.nodes.get("api"))

  const moving = at(plan.windows.move.duration / 2)
  assert.equal(moving.nodes.get("engine")?.opacity, 0, "new nodes wait for the moves")
  assert.equal(moving.edges.get("api->engine")?.draw, 0)

  const appearing = at(plan.windows.appear.start + plan.windows.appear.duration)
  assert.equal(appearing.nodes.get("engine")?.opacity, 1)
  assert.equal(appearing.edges.get("api->engine")?.draw, 0, "new edges wait for their nodes")
  assert.equal(at(plan.duration).edges.get("api->engine")?.draw, 1)
})

test("edges stay attached to their nodes while the nodes move", () => {
  const from = stage(0)
  const to = stage(1)
  const plan = planTransition(diagram, from, to)
  const frame = frameAt(frameOf(diagram, from), to, plan, plan.windows.move.duration * 0.4)
  const edge = diagram.edges.find((candidate) => candidate.id === "client->api")
  const route = frame.edges.get("client->api")?.route
  const client = frame.nodes.get("client")
  const api = frame.nodes.get("api")
  assert.ok(edge !== undefined && route !== undefined && client !== undefined && api !== undefined)

  const clientRect = nodeRect(client.view, client.center, client.scale)
  const apiRect = nodeRect(api.view, api.center, api.scale)
  const [curve] = edgeGeometry(edge, route, clientRect, apiRect).path
  assert.ok(curve !== undefined)

  assert.ok(Math.abs(curve.from[0] - (clientRect.x + clientRect.width)) < 10, "leaves the moving source")
  assert.ok(Math.abs(curve.to[0] - apiRect.x) < 10, "enters the moving target")
})

test("an interrupted transition carries on from where it stopped", () => {
  const plan = planTransition(diagram, stage(0), stage(1))
  const middle = frameAt(frameOf(diagram, stage(0)), stage(1), plan, plan.windows.move.duration / 2)
  const back = planTransition(diagram, sceneOfFrame(middle), stage(0))
  const resumed = frameAt(middle, stage(0), back, 0)

  assert.deepEqual(resumed.nodes.get("api")?.center, middle.nodes.get("api")?.center)
  assert.deepEqual(back.appear, [], "nodes that never appeared don't need to leave")
  assert.deepEqual(
    frameAt(middle, stage(0), back, back.duration).nodes.get("api")?.center,
    stage(0).layout.nodes.get("api"),
  )
})

test("an edge alone on a side attaches at its centre, and slides aside before a second one draws in", () => {
  const sharing = defineArchitecture({
    canvas: {
      width: 1200,
      height: 600,
    },
    nodes: {
      client: {
        label: "Client",
      },
      api: {
        label: "API",
      },
    },
    edges: [
      {
        from: "client",
        to: "api",
      },
      {
        id: "list",
        from: "client",
        to: "api",
        stage: 1,
      },
    ],
    stages: [["client", "api"], []],
  })
  const alone = stage(0, sharing).layout.edges.get("client->api")
  const shared = stage(1, sharing).layout.edges.get("client->api")
  assert.ok(alone !== undefined && shared !== undefined)

  assert.deepEqual([alone.from.v, alone.to.v], [0, 0])
  assert.notEqual(shared.from.v, 0)
  assert.equal(shared.to.v, shared.from.v, "it stays parallel to the other edge")

  const plan = planTransition(sharing, stage(0, sharing), stage(1, sharing))
  const { move, draw } = plan.windows
  assert.deepEqual(plan.move, ["client->api"])
  assert.deepEqual(plan.draw, ["list"])
  assert.ok(move.duration > 0 && draw.start >= move.start + move.duration)

  const settled = frameAt(frameOf(sharing, stage(0, sharing)), stage(1, sharing), plan, move.start + move.duration)
  assert.deepEqual(settled.edges.get("client->api")?.route, shared)
  assert.equal(settled.edges.get("list")?.draw, 0, "the new edge waits for the slide")

  const back = planTransition(sharing, stage(1, sharing), stage(0, sharing))
  assert.deepEqual([back.retract, back.move], [["list"], ["client->api"]])
  assert.ok(back.windows.move.start >= back.windows.retract.duration)
})

const limiter = defineArchitecture({
  canvas: {
    width: 1600,
    height: 700,
  },
  nodes: {
    controller: {
      label: "Controller",
    },
    limiter: {
      label: "Limiter",
      contains: ["rateLimit", "bouncer"],
      collapsed: true,
    },
    rateLimit: {
      label: "RateLimiting",
    },
    bouncer: {
      label: "Bouncer",
    },
    engine: {
      label: "Engine",
    },
  },
  edges: [
    {
      from: "controller",
      to: "rateLimit",
    },
    {
      from: "rateLimit",
      to: "bouncer",
    },
    {
      from: "bouncer",
      to: "engine",
    },
  ],
  stages: [["controller", "limiter", "engine"], ["expand:limiter"]],
})

function rectOfFrame(frame: Frame, id: string) {
  const node = frame.nodes.get(id)
  assert.ok(node !== undefined, `${id} is drawn`)
  return nodeRect({ ...node.view, size: node.size }, node.center, node.scale)
}

test("expanding moves the neighbours apart, opens the box into its group as the members grow, then draws inside", () => {
  const from = stage(0, limiter)
  const to = stage(1, limiter)
  const plan = planTransition(limiter, from, to)

  assert.deepEqual(plan.expand, ["limiter"])
  assert.deepEqual(plan.collapse, [])
  assert.deepEqual([...plan.members], [
    ["rateLimit", "limiter"],
    ["bouncer", "limiter"],
  ])
  assert.deepEqual(sorted(plan.move.filter((id) => !id.includes("->"))), ["controller", "engine"])
  assert.deepEqual(plan.draw, ["rateLimit->bouncer"])
  assert.deepEqual(sorted(plan.keep), ["bouncer->engine", "controller->rateLimit"])
  assert.deepEqual([plan.appear, plan.disappear, plan.retract], [[], [], []])

  const { retract, disappear, move, appear, draw } = plan.windows
  assert.equal(retract.duration + disappear.duration, 0)
  assert.ok(move.duration > 0 && appear.duration > 0 && draw.duration > 0)
  assert.equal(appear.start, move.start + move.duration)
  assert.equal(draw.start, appear.start + appear.duration)

  const start = frameOf(limiter, from)
  const at = (t: number): Frame => frameAt(start, to, plan, t)
  const moving = at(move.duration / 2)
  assert.equal(moving.nodes.get("limiter")?.opacity, 1, "the box stays whole while the neighbours move")
  assert.equal(moving.nodes.get("rateLimit")?.opacity, 0)
  assert.equal(moving.groups.get("limiter")?.opacity, 0)
  assert.deepEqual(moving.edges.get("bouncer->engine")?.from, "limiter")

  const opening = at(appear.start)
  const box = rectOfFrame(at(appear.start - 1), "limiter")
  const child = rectOfFrame(opening, "bouncer")
  assert.ok(Math.abs(box.x - child.x) < 1 && Math.abs(box.width - child.width) < 1, "members start as the box")
  assert.equal(opening.edges.get("bouncer->engine")?.from, "bouncer", "external edges move over to the members")

  const half = at(appear.start + appear.duration / 2)
  const group = half.groups.get("limiter")
  const final = to.layout.groups.get("limiter")
  assert.ok(group !== undefined && final !== undefined)
  assert.ok(group.rect.width > box.width && group.rect.width < final.width, "the box widens into the outline")
  assert.ok((half.nodes.get("rateLimit")?.opacity ?? 0) > 0)
  assert.equal(half.edges.get("rateLimit->bouncer")?.draw, 0, "the inside edge waits for the members")
  assert.equal(at(plan.duration).edges.get("rateLimit->bouncer")?.draw, 1)
})

test("collapsing plays the expansion backwards: inside edges retract, members shrink into the box, then it moves", () => {
  const from = stage(1, limiter)
  const to = stage(0, limiter)
  const plan = planTransition(limiter, from, to)

  assert.deepEqual([plan.expand, plan.collapse], [[], ["limiter"]])
  assert.deepEqual(plan.retract, ["rateLimit->bouncer"])
  assert.deepEqual(sorted(plan.keep), ["bouncer->engine", "controller->rateLimit"])
  assert.deepEqual([plan.appear, plan.disappear, plan.draw], [[], [], []])

  const { retract, disappear, move, appear, draw } = plan.windows
  assert.equal(disappear.start, retract.start + retract.duration)
  assert.equal(move.start, disappear.start + disappear.duration)
  assert.equal(appear.duration + draw.duration, 0)

  const start = frameOf(limiter, from)
  const at = (t: number): Frame => frameAt(start, to, plan, t)
  assert.equal(at(disappear.start).edges.get("rateLimit->bouncer")?.draw, 0, "the inside edge is gone first")
  assert.equal(at(disappear.start).edges.get("bouncer->engine")?.from, "bouncer")

  const shut = at(move.start)
  const box = rectOfFrame(shut, "limiter")
  const child = rectOfFrame(at(move.start - 1), "bouncer")
  assert.ok(Math.abs(box.x - child.x) < 2 && Math.abs(box.width - child.width) < 2, "members end as the box")
  assert.equal(shut.nodes.get("limiter")?.opacity, 1)
  assert.equal(shut.groups.get("limiter")?.opacity, 0)
  assert.equal(shut.edges.get("bouncer->engine")?.from, "limiter", "external edges move back to the box")
  assert.deepEqual(at(plan.duration).nodes.get("limiter")?.center, to.layout.nodes.get("limiter"))
})

test("a click plays the same choreography as a token, and clicking again mid-way turns it round", () => {
  const from = stage(0, limiter)
  const clicked = limiter.stageWith(0, new Set(["limiter"]))
  const plan = planTransition(limiter, from, clicked)
  assert.deepEqual([plan.expand, plan.draw], [["limiter"], ["rateLimit->bouncer"]])

  const middle = frameAt(frameOf(limiter, from), clicked, plan, plan.windows.appear.start + plan.windows.appear.duration * 0.75)
  const back = planTransition(limiter, sceneOfFrame(middle), from)
  assert.deepEqual(back.collapse, ["limiter"])
  assert.deepEqual(
    frameAt(middle, from, back, back.duration).nodes.get("limiter")?.center,
    from.layout.nodes.get("limiter"),
  )
})
