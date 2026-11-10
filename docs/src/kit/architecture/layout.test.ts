import assert from "node:assert/strict"
import { test } from "node:test"

import type { Rect } from "./geometry.ts"
import { assignRanks, edgeGeometry, labelSize, nodeRect, stackOffset } from "./layout.ts"
import {
  type ArchitectureDefinition,
  type ArchitectureDiagram,
  type DiagramEdge,
  type DiagramNode,
  defineArchitecture,
  type StageState,
} from "./model.ts"

const pipeline: ArchitectureDefinition = {
  canvas: {
    width: 1600,
    height: 700,
  },
  nodes: {
    client: {
      label: "Client",
      icon: "user",
    },
    api: {
      label: "API",
      icon: "workers",
    },
    queue: {
      label: "Queue",
      icon: "queues",
    },
    cache: {
      label: "Cache",
      icon: "kv",
    },
    worker: {
      label: "Worker",
      icon: "workers",
      replicas: 3,
    },
    store: {
      label: "Store",
      icon: "database",
    },
  },
  edges: [
    {
      from: "client",
      to: "api",
      label: "request",
    },
    {
      from: "api",
      to: "client",
      label: "response",
      back: true,
    },
    {
      from: "api",
      to: "queue",
      label: "enqueue",
    },
    {
      from: "api",
      to: "cache",
      label: "read",
    },
    {
      from: "queue",
      to: "worker",
    },
    {
      from: "worker",
      to: "store",
      label: "write",
    },
    {
      from: "cache",
      to: "store",
    },
  ],
  notes: [
    {
      id: "hint",
      text: "Cached for 60s",
      near: "cache",
    },
  ],
  stages: [["client", "api"], ["queue", "worker"], ["cache", "store", "hint"]],
}

function stageOf(diagram: ArchitectureDiagram, index: number): StageState {
  const state = diagram.stages[index]
  assert.ok(state !== undefined)
  return state
}

function rectOf(state: StageState, id: string): Rect {
  const view = state.nodes.get(id)
  const center = state.layout.nodes.get(id)
  assert.ok(view !== undefined && center !== undefined, `${id} is laid out`)
  return nodeRect(view, center, state.layout.scale)
}

function footprintOf(state: StageState, id: string): Rect {
  const rect = rectOf(state, id)
  const stack = stackOffset(state.nodes.get(id)?.replicas) * state.layout.scale
  return {
    ...rect,
    y: rect.y - stack,
    width: rect.width + stack,
    height: rect.height + stack,
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function node(id: string, extra: Partial<DiagramNode> = {}): DiagramNode {
  return {
    id,
    label: id,
    replaces: [],
    ...extra,
  }
}

function edge(from: string, to: string, extra: Partial<DiagramEdge> = {}): DiagramEdge {
  return {
    id: `${from}->${to}`,
    from,
    to,
    label: undefined,
    labelAt: undefined,
    flow: undefined,
    color: undefined,
    bend: undefined,
    both: false,
    back: false,
    stage: 0,
    ...extra,
  }
}

test("layout is deterministic", () => {
  const first = defineArchitecture(pipeline).stages.map((state) => state.layout)
  const second = defineArchitecture(pipeline).stages.map((state) => state.layout)

  assert.deepEqual(first, second)
})

test("ranks follow edges; back, two-way, and cycle-closing edges don't push", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => node(id))
  const ranks = assignRanks(nodes, [
    edge("a", "b"),
    edge("b", "c"),
    edge("c", "a"),
    edge("c", "b", { back: true }),
    edge("d", "a", { both: true }),
  ])

  assert.equal(ranks.get("a"), 0)
  assert.equal(ranks.get("b"), 1)
  assert.equal(ranks.get("c"), 2)
  assert.equal(ranks.get("d"), 0, "an edge with heads at both ends doesn't rank")
})

test("rank hints: rank fixes, after follows, below shares, sources sit next to their successor", () => {
  const ranks = assignRanks(
    [
      node("a"),
      node("b"),
      node("c", { below: "b" }),
      node("late", { rank: 4 }),
      node("next", { after: "a" }),
      node("source"),
    ],
    [edge("a", "b"), edge("b", "c"), edge("source", "late")],
  )

  assert.equal(ranks.get("c"), ranks.get("b"), "below shares the rank and drops the edge between them")
  assert.equal(ranks.get("next"), (ranks.get("a") ?? 0) + 1)
  assert.equal(ranks.get("source"), (ranks.get("late") ?? 0) - 1)
  assert.ok((ranks.get("late") ?? 0) > (ranks.get("b") ?? 0), "empty ranks close up but order holds")
})

test("each stage is centred in the canvas and scaled to fit", () => {
  const crowded = defineArchitecture({
    ...pipeline,
    canvas: {
      width: 700,
      height: 400,
    },
  })

  for (const diagram of [defineArchitecture(pipeline), crowded]) {
    for (const state of diagram.stages) {
      const rects = [...state.layout.nodes.keys()].map((id) => footprintOf(state, id))
      const left = Math.min(...rects.map((rect) => rect.x))
      const right = Math.max(...rects.map((rect) => rect.x + rect.width))
      const top = Math.min(...rects.map((rect) => rect.y))
      const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))

      assert.ok(left >= 0 && top >= 0, "inside the top-left corner")
      assert.ok(right <= diagram.canvas.width && bottom <= diagram.canvas.height, "inside the bottom-right corner")
      assert.ok(state.layout.scale <= 1)
    }
  }

  const first = stageOf(defineArchitecture(pipeline), 0)
  const client = rectOf(first, "client")
  const api = rectOf(first, "api")
  const middle = (client.x + api.x + api.width) / 2
  assert.ok(Math.abs(middle - 800) < 1, `two nodes centre on the canvas, got ${middle}`)
  assert.ok(Math.abs(client.y + client.height / 2 - 350) < 1)
  assert.ok(stageOf(crowded, 2).layout.scale < 1, "a crowded canvas scales the drawing down")
})

test("nodes never overlap", () => {
  const diagram = defineArchitecture(pipeline)

  for (const state of diagram.stages) {
    const ids = [...state.layout.nodes.keys()]

    for (const [index, a] of ids.entries()) {
      for (const b of ids.slice(index + 1)) {
        assert.ok(!overlaps(footprintOf(state, a), footprintOf(state, b)), `${a} and ${b} overlap`)
      }
    }
  }
})

test("nodes keep their order within a rank as later stages add nodes", () => {
  const fan: ArchitectureDefinition = {
    canvas: {
      width: 1400,
      height: 800,
    },
    nodes: Object.fromEntries(["hub", "a", "b", "c", "d", "e"].map((id) => [id, { label: id.toUpperCase() }])),
    edges: ["a", "b", "c", "d", "e"].map((id) => ({
      from: "hub",
      to: id,
    })),
    stages: [["hub", "c", "a"], ["e"], ["b", "d"]],
  }
  const diagram = defineArchitecture(fan)
  const order = (state: StageState, ids: ReadonlyArray<string>): ReadonlyArray<string> =>
    [...ids].sort((x, y) => (state.layout.nodes.get(x)?.[1] ?? 0) - (state.layout.nodes.get(y)?.[1] ?? 0))

  const first = order(stageOf(diagram, 0), ["a", "c"])
  const second = order(stageOf(diagram, 1), ["a", "c", "e"])
  const third = order(stageOf(diagram, 2), ["a", "b", "c", "d", "e"])

  assert.deepEqual(
    second.filter((id) => first.includes(id)),
    first,
  )
  assert.deepEqual(
    third.filter((id) => second.includes(id)),
    second,
  )
})

test("rank-adjacent edges run side to side, same-rank edges top to bottom", () => {
  const state = stageOf(
    defineArchitecture({
      ...pipeline,
      nodes: {
        ...pipeline.nodes,
        cache: {
          label: "Cache",
          below: "queue",
        },
      },
      edges: [
        ...(pipeline.edges ?? []),
        {
          from: "queue",
          to: "cache",
          label: "warm",
        },
      ],
    }),
    2,
  )

  const across = state.layout.edges.get("client->api")
  const down = state.layout.edges.get("queue->cache")
  assert.ok(across !== undefined && down !== undefined)
  assert.deepEqual([across.from.u, across.to.u], [1, -1])
  assert.deepEqual([down.from.v, down.to.v], [1, -1])
  assert.notDeepEqual(down.labelOffset, [0, 0], "a label too big for a short edge sits beside it")

  const queue = rectOf(state, "queue")
  const cache = rectOf(state, "cache")
  assert.ok(Math.abs(queue.x + queue.width / 2 - (cache.x + cache.width / 2)) < 1, "below aligns the centres")
  assert.ok(cache.y > queue.y + queue.height)
})

test("aligned nodes get straight edges that start and end outside both nodes", () => {
  const diagram = defineArchitecture(pipeline)
  const state = stageOf(diagram, 0)
  const line = diagram.edges.find((candidate) => candidate.id === "client->api")
  const route = state.layout.edges.get("client->api")
  assert.ok(line !== undefined && route !== undefined)

  const client = rectOf(state, "client")
  const api = rectOf(state, "api")
  const [curve] = edgeGeometry(line, route, client, api).path
  assert.ok(curve !== undefined)

  assert.ok(curve.from[0] > client.x + client.width && curve.to[0] < api.x)
  assert.ok(Math.abs(curve.from[1] - curve.to[1]) < 25, "nearly level: the two edges between them sit side by side")
  assert.ok(curve.to[0] - curve.from[0] > 100, "no stubs")
})

test("labels stay clear of nodes and of each other", () => {
  const diagram = defineArchitecture(pipeline)

  for (const state of diagram.stages) {
    const labels = diagram.edges.flatMap((candidate) => {
      const route = state.layout.edges.get(candidate.id)

      if (route === undefined || candidate.label === undefined) {
        return []
      }

      const { labelPoint } = edgeGeometry(candidate, route, rectOf(state, candidate.from), rectOf(state, candidate.to))
      const [width, height] = labelSize(candidate.label).map((value) => value * state.layout.scale * 0.8)
      return [
        {
          id: candidate.id,
          rect: {
            x: labelPoint[0] - (width ?? 0) / 2,
            y: labelPoint[1] - (height ?? 0) / 2,
            width: width ?? 0,
            height: height ?? 0,
            radius: 0,
          },
        },
      ]
    })

    for (const [index, label] of labels.entries()) {
      for (const id of state.layout.nodes.keys()) {
        assert.ok(!overlaps(label.rect, footprintOf(state, id)), `label ${label.id} covers ${id}`)
      }

      for (const other of labels.slice(index + 1)) {
        assert.ok(!overlaps(label.rect, other.rect), `labels ${label.id} and ${other.id} overlap`)
      }
    }
  }
})

test("notes sit beside their node, and `down` runs ranks top to bottom", () => {
  const state = stageOf(
    defineArchitecture({
      ...pipeline,
      direction: "down",
      canvas: {
        width: 900,
        height: 1200,
      },
    }),
    2,
  )

  const client = rectOf(state, "client")
  const store = rectOf(state, "store")
  assert.ok(store.y > client.y + client.height, "the last rank is lowest")

  const note = state.layout.notes.get("hint")
  const cache = rectOf(state, "cache")
  assert.ok(note !== undefined)
  assert.ok(Math.hypot(note[0] - (cache.x + cache.width / 2), note[1] - (cache.y + cache.height / 2)) < 150)
})

test("pinned nodes keep their canvas position", () => {
  const state = stageOf(
    defineArchitecture({
      ...pipeline,
      nodes: {
        ...pipeline.nodes,
        store: {
          label: "Store",
          pin: [1500, 80],
        },
      },
    }),
    2,
  )

  assert.deepEqual(state.layout.nodes.get("store"), [1500, 80])
})
