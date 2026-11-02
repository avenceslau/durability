import assert from "node:assert/strict"
import { test } from "node:test"

import { controlPlane, engineVersions, fanOut } from "./fixtures.ts"
import { isStraight, type Path, pointOnPath, type Rect, tangentAt } from "./geometry.ts"
import { crossings, edgeGeometry, labelSize, nodeRect } from "./layout.ts"
import {
  type ArchitectureDiagram,
  type DiagramEdge,
  defineArchitecture,
  shownStage,
  type StageState,
} from "./model.ts"

/** The nodes an edge is drawn between, which a collapsed composite takes over from its children. */
function drawnEnds(state: StageState, edge: DiagramEdge): readonly [string, string] {
  return state.ends.get(edge.id) ?? [edge.from, edge.to]
}

/** Each build of a diagram, and each build again with every composite clicked open or shut. */
function builds(diagram: ArchitectureDiagram): ReadonlyArray<readonly [string, StageState]> {
  const composites = diagram.nodes.filter((node) => node.contains.length > 0).map((node) => node.id)

  return diagram.stages.flatMap((state, index) => [
    [`stage ${index}`, state] as const,
    ...composites.map((id) => {
      const clicks = new Map([[id, !state.expanded.has(id)]])
      return [`stage ${index} with ${id} clicked`, shownStage(diagram, index, clicks)] as const
    }),
  ])
}

/** Every pair of shown edges that cross in a stage, as "a x b". */
function crossingPairs(diagram: ArchitectureDiagram, state: StageState): ReadonlyArray<string> {
  const rect = (id: string) => {
    const view = state.nodes.get(id)
    const center = state.layout.nodes.get(id)
    assert.ok(view !== undefined && center !== undefined)
    return nodeRect(view, center, state.layout.scale)
  }
  const lines = diagram.edges
    .filter((edge) => state.visible.has(edge.id))
    .map((edge) => {
      const route = state.layout.edges.get(edge.id)
      assert.ok(route !== undefined, `${edge.id} is routed`)
      const [from, to] = drawnEnds(state, edge)
      const { path } = edgeGeometry(edge, route, rect(from), rect(to))
      return {
        id: edge.id,
        points: Array.from({ length: 81 }, (_, index) => pointOnPath(path, index / 80)),
      }
    })

  return lines.flatMap((a, index) =>
    lines.slice(index + 1).flatMap((b) => (crossings(a.points, b.points) > 0 ? [`${a.id} x ${b.id}`] : [])),
  )
}

test("a long edge arriving last finds a way in without crossing the edges already there", () => {
  const diagram = defineArchitecture({
    canvas: {
      width: 1600,
      height: 676,
    },
    nodes: {
      controller: {
        label: "Config Controller",
        row: 0,
      },
      rateLimit: {
        label: "RateLimiting",
        row: 0,
      },
      bouncer: {
        label: "Bouncer",
        row: 0,
      },
      engineInstance: {
        label: "Engine Instance",
        row: 0,
      },
      account: {
        label: "Account",
        below: "bouncer",
      },
      souschef: {
        label: "SousChef",
        replicas: 3,
        below: "engineInstance",
      },
      watchdog: {
        label: "Watchdog",
        below: "souschef",
      },
      terminator: {
        label: "Terminator",
        below: "account",
      },
    },
    edges: [
      { from: "controller", to: "rateLimit" },
      { from: "rateLimit", to: "bouncer" },
      { from: "bouncer", to: "engineInstance" },
      { from: "engineInstance", to: "souschef", label: "register" },
      { from: "souschef", to: "account", label: "ask for concurrency", back: true },
      { from: "account", to: "souschef", label: "slots" },
      { from: "watchdog", to: "souschef" },
      { from: "souschef", to: "terminator", label: "delete workflow" },
      { from: "controller", to: "souschef", stage: 1 },
    ],
    stages: [["controller", "rateLimit", "bouncer", "engineInstance", "account", "souschef", "watchdog", "terminator"], []],
  })
  const [before, after] = diagram.stages
  assert.ok(before !== undefined && after !== undefined)

  assert.deepEqual(crossingPairs(diagram, after), [])
  assert.deepEqual(
    after.layout.edges.get("account->souschef"),
    before.layout.edges.get("account->souschef"),
    "the edges already there keep their routes when the new one appears",
  )
  assert.deepEqual(after.layout.nodes, before.layout.nodes, "and the nodes stay put")
})

test("an edge bows round another edge rather than cross it", () => {
  // The straight route from left to right would slip between top and bottom, across the edge joining them.
  const diagram = defineArchitecture({
    canvas: {
      width: 800,
      height: 500,
    },
    layout: "manual",
    snap: false,
    nodes: {
      left: {
        label: "Left",
        at: [100, 240],
      },
      right: {
        label: "Right",
        at: [700, 240],
      },
      top: {
        label: "Top",
        at: [400, 190],
      },
      bottom: {
        label: "Bottom",
        at: [400, 290],
      },
    },
    edges: [
      { from: "top", to: "bottom" },
      { from: "left", to: "right" },
    ],
  })
  const state = diagram.stages[0]
  assert.ok(state !== undefined)

  assert.deepEqual(crossingPairs(diagram, state), [])
  assert.notEqual(state.layout.edges.get("left->right")?.bend, 0)
})

test("the playground's auto-layout diagrams have no crossing edges in any stage", () => {
  for (const [name, diagram] of Object.entries({ controlPlane, fanOut, engineVersions })) {
    for (const [build, state] of builds(diagram)) {
      assert.deepEqual(crossingPairs(diagram, state), [], `${name} ${build}`)
    }
  }
})

test("the control plane's first edge leaves the client at its centre until the list edges join it", () => {
  const first = controlPlane.stages[0]?.layout.edges.get("client->controller")
  const listed = controlPlane.stages[5]?.layout.edges.get("client->controller")
  assert.ok(first !== undefined && listed !== undefined)

  assert.deepEqual([first.from.v, first.to.v], [0, 0])
  assert.notEqual(listed.from.v, 0)
})

function stageRects(state: StageState): ReadonlyMap<string, Rect> {
  return new Map(
    [...state.layout.nodes].flatMap(([id, center]) => {
      const view = state.nodes.get(id)
      if (view === undefined || !state.visible.has(id)) {
        return []
      }

      return [[id, nodeRect(view, center, state.layout.scale)] as const]
    }),
  )
}

test("orthogonal edges run in straight lines through the gaps between nodes, never through one", () => {
  const state = controlPlane.stages.at(-1)
  assert.ok(state !== undefined)
  const rects = stageRects(state)
  const elbows = controlPlane.edges.filter((edge) => state.layout.edges.get(edge.id)?.shape === "orthogonal")
  assert.ok(elbows.length >= 5)

  for (const edge of elbows) {
    const route = state.layout.edges.get(edge.id)
    const [fromId, toId] = drawnEnds(state, edge)
    const from = rects.get(fromId)
    const to = rects.get(toId)
    assert.ok(route !== undefined && from !== undefined && to !== undefined)
    const { path } = edgeGeometry(edge, route, from, to)

    for (const curve of path.filter(isStraight)) {
      const level = Math.abs(curve.from[0] - curve.to[0]) < 0.01 || Math.abs(curve.from[1] - curve.to[1]) < 0.01
      assert.ok(level, `${edge.id} runs only across and down`)
    }

    for (const [id, rect] of rects) {
      if (id === fromId || id === toId) {
        continue
      }

      const inside = Array.from({ length: 101 }, (_, index) => pointOnPath(path, index / 100)).some(
        ([x, y]) => x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height,
      )
      assert.ok(!inside, `${edge.id} passes through ${id}`)
    }
  }
})

test("ports sharing a side keep arrowheads apart and stay off the rounded corners", () => {
  for (const [index, state] of controlPlane.stages.entries()) {
    const rects = stageRects(state)
    const ends = new Map<string, Array<{ readonly at: number; readonly head: boolean }>>()

    for (const edge of controlPlane.edges.filter((candidate) => state.visible.has(candidate.id))) {
      const route = state.layout.edges.get(edge.id)
      assert.ok(route !== undefined)

      for (const [id, port, head] of [
        [drawnEnds(state, edge)[0], route.from, edge.both],
        [drawnEnds(state, edge)[1], route.to, true],
      ] as const) {
        const rect = rects.get(id)
        assert.ok(rect !== undefined)
        const vertical = port.nx !== 0
        const half = (vertical ? rect.height : rect.width) / 2
        const along = (vertical ? port.v : port.u) * half
        const where = `stage ${index}: ${edge.id} attaches at a corner of ${id}`
        assert.ok(Math.abs(along) <= half - rect.radius + 0.01, where)

        const key = `${id}|${port.nx}|${port.ny}`
        ends.set(key, [...(ends.get(key) ?? []), { at: along, head }])
      }
    }

    for (const [key, list] of ends) {
      const heads = list.filter((end) => end.head).map((end) => end.at).sort((a, b) => a - b)
      const all = list.map((end) => end.at).sort((a, b) => a - b)
      heads.slice(1).forEach((at, position) => {
        assert.ok(at - (heads[position] ?? 0) >= 14.99, `stage ${index}: arrowheads on ${key} overlap`)
      })
      all.slice(1).forEach((at, position) => {
        assert.ok(at - (all[position] ?? 0) > 5, `stage ${index}: ports on ${key} collide`)
      })
    }
  }
})

test("the list edge drops from the controller as an elbow into the SousChef's top, left of register", () => {
  const state = controlPlane.stages.at(-1)
  assert.ok(state !== undefined)
  const list = state.layout.edges.get("controller->souschef")
  const register = state.layout.edges.get("engineInstance->souschef")
  assert.ok(list !== undefined && register !== undefined)

  assert.equal(list.shape, "orthogonal")
  assert.deepEqual([list.from.ny, list.to.ny], [1, -1], "out of the bottom, into the top")
  assert.deepEqual(register.to.ny, -1)
  assert.ok(list.to.u < register.to.u, "left of register")

  const rects = stageRects(state)
  const edge = controlPlane.edges.find((candidate) => candidate.id === "controller->souschef")
  const from = rects.get("controller")
  const to = rects.get("souschef")
  assert.ok(edge !== undefined && from !== undefined && to !== undefined)
  const { path } = edgeGeometry(edge, list, from, to)
  assert.equal(path.filter(isStraight).length, 3, "down, across, down")
})

function pathOf(diagram: ArchitectureDiagram, state: StageState, id: string): Path {
  const edge = diagram.edges.find((candidate) => candidate.id === id)
  const route = state.layout.edges.get(id)
  const rects = stageRects(state)
  const [fromId, toId] = edge === undefined ? ["", ""] : drawnEnds(state, edge)
  const from = rects.get(fromId)
  const to = rects.get(toId)
  assert.ok(edge !== undefined && route !== undefined && from !== undefined && to !== undefined, `${id} is drawn`)
  return edgeGeometry(edge, route, from, to).path
}

/** Each shown label's box as the layout sizes it, and as the knockout drawn under it. */
function labelBoxes(
  diagram: ArchitectureDiagram,
  state: StageState,
): ReadonlyArray<{
  readonly id: string
  readonly box: Rect
  readonly knockout: Rect
}> {
  const rects = stageRects(state)

  return diagram.edges.flatMap((edge) => {
    const route = state.layout.edges.get(edge.id)
    const [fromId, toId] = drawnEnds(state, edge)
    const from = rects.get(fromId)
    const to = rects.get(toId)

    if (edge.label === undefined || !state.visible.has(edge.id) || route === undefined || !from || !to) {
      return []
    }

    const [x, y] = edgeGeometry(edge, route, from, to).labelPoint
    const [width, height] = labelSize(edge.label).map((value) => value * state.layout.scale) as [number, number]
    const inner = [width * 0.82, height - 10 * state.layout.scale] as const
    return [
      {
        id: edge.id,
        box: { x: x - width / 2, y: y - height / 2, width, height, radius: 0 },
        knockout: { x: x - inner[0] / 2, y: y - inner[1] / 2, width: inner[0], height: inner[1], radius: 0 },
      },
    ]
  })
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function contains(rect: Rect, [x, y]: readonly [number, number]): boolean {
  return x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height
}

test("the three edges between the client and the controller run level on ports of their own, in order", () => {
  const state = controlPlane.stages[5]
  assert.ok(state !== undefined)
  const ids = ["client->controller", "listRequest", "controller->client"]
  const heights = ids.map((id) => {
    const path = pathOf(controlPlane, state, id)
    const start = path[0]?.from
    const end = path.at(-1)?.to
    assert.ok(start !== undefined && end !== undefined)
    assert.ok(Math.abs(start[1] - end[1]) < 0.01, `${id} runs level`)
    assert.ok(path.every(isStraight), `${id} is a straight line`)
    return start[1]
  })

  heights.slice(1).forEach((height, index) => {
    assert.ok(height - (heights[index] ?? 0) >= 10, "in declaration order, top to bottom, apart")
  })

  const rects = stageRects(state)
  const client = rects.get("client")
  const controller = rects.get("controller")
  assert.ok(client !== undefined && controller !== undefined)
  const labels = labelBoxes(controlPlane, state).filter(({ id }) => ids.includes(id))
  assert.equal(labels.length, 3)

  for (const [index, { id, box, knockout }] of labels.entries()) {
    assert.ok(box.x > client.x + client.width && box.x + box.width < controller.x, `${id}'s label fits the gap`)

    for (const other of labels.slice(index + 1)) {
      assert.ok(!overlaps(box, other.box), `labels ${id} and ${other.id} overlap`)
    }

    for (const line of ids.filter((other) => other !== id)) {
      const path = pathOf(controlPlane, state, line)
      const hidden = Array.from({ length: 101 }, (_, step) => pointOnPath(path, step / 100)).some((point) =>
        contains(knockout, point),
      )
      assert.ok(!hidden, `${id}'s label covers ${line}`)
    }
  }

  const [create, , cursor] = ids.map((id) => state.layout.edges.get(id))
  assert.ok((create?.labelOffset[1] ?? 0) < 0, "the top edge carries its label above")
  assert.ok((cursor?.labelOffset[1] ?? 0) > 0, "the bottom edge carries its label below")
  assert.deepEqual(state.layout.edges.get("listRequest")?.labelOffset, [0, 0], "the middle one on its line")
})

test("parallel edges with room between them carry their labels there, on their lines", () => {
  const diagram = defineArchitecture({
    canvas: {
      width: 900,
      height: 500,
    },
    nodes: {
      left: {
        label: "Left",
        size: [160, 200],
      },
      right: {
        label: "Right",
        size: [160, 200],
      },
    },
    edges: [
      { from: "left", to: "right", label: "ask" },
      { from: "right", to: "left", label: "answer", back: true },
    ],
  })
  const state = diagram.stages[0]
  assert.ok(state !== undefined)

  for (const id of ["left->right", "right->left"]) {
    assert.deepEqual(state.layout.edges.get(id)?.labelOffset, [0, 0], id)
  }

  const [ask, answer] = labelBoxes(diagram, state)
  assert.ok(ask !== undefined && answer !== undefined && !overlaps(ask.box, answer.box))
})

test("a rank gap widens for the widest label of any edge across it", () => {
  const gapWith = (labels: ReadonlyArray<string>): number => {
    const diagram = defineArchitecture({
      // Narrow, so spare room doesn't widen the gaps.
      canvas: {
        width: 600,
        height: 400,
      },
      nodes: {
        a: {
          label: "A",
        },
        b: {
          label: "B",
        },
        c: {
          label: "C",
        },
      },
      edges: [
        ...labels.map((label, index) => ({ id: `ab${index}`, from: "a", to: "b", label })),
        { from: "b", to: "c", label: "a label wider than the rest of them" },
      ],
    })
    const state = diagram.stages[0]
    assert.ok(state !== undefined)
    const rects = stageRects(state)
    const a = rects.get("a")
    const b = rects.get("b")
    assert.ok(a !== undefined && b !== undefined)
    return (b.x - (a.x + a.width)) / state.layout.scale
  }

  const one = gapWith(["go"])
  const two = gapWith(["go", "and a much longer label"])
  assert.ok(two > one + 100, `${two} > ${one}`)
  assert.ok(two >= labelSize("and a much longer label")[0], "the longer label fits")
})

test("every build keeps labels clear of each other, of nodes and notes, and of other edges", () => {
  for (const [name, diagram] of Object.entries({ controlPlane })) {
    for (const [build, state] of builds(diagram)) {
      const where = `${name} ${build}`
      const labels = labelBoxes(diagram, state)
      const nodes = [...stageRects(state)]
      const notes = diagram.notes.flatMap((note) => {
        const centre = state.layout.notes.get(note.id)
        const [width, height] = note.size.map((value) => value * state.layout.scale) as [number, number]
        return centre === undefined || !state.visible.has(note.id)
          ? []
          : [{ x: centre[0] - width / 2, y: centre[1] - height / 2, width, height, radius: 0 }]
      })
      const lines = diagram.edges
        .filter((edge) => state.visible.has(edge.id))
        .map((edge) => ({
          id: edge.id,
          points: Array.from({ length: 121 }, (_, step) => pointOnPath(pathOf(diagram, state, edge.id), step / 120)),
        }))

      for (const [position, label] of labels.entries()) {
        for (const other of labels.slice(position + 1)) {
          assert.ok(!overlaps(label.box, other.box), `${where}: labels ${label.id} and ${other.id} overlap`)
        }

        for (const [id, rect] of nodes) {
          assert.ok(!overlaps(label.box, rect), `${where}: label ${label.id} covers ${id}`)
        }

        for (const note of notes) {
          assert.ok(!overlaps(label.box, note), `${where}: label ${label.id} covers a note`)
        }

        for (const line of lines.filter(({ id }) => id !== label.id)) {
          assert.ok(
            !line.points.some((point) => contains(label.knockout, point)),
            `${where}: label ${label.id} hides ${line.id}`,
          )
        }
      }
    }
  }
})

test("elbows turn through rounded corners, with their middle runs inside the gap between their ends", () => {
  const state = controlPlane.stages.at(-1)
  assert.ok(state !== undefined)
  const elbows = controlPlane.edges.filter((edge) => state.layout.edges.get(edge.id)?.shape === "orthogonal")

  for (const edge of elbows) {
    const path = pathOf(controlPlane, state, edge.id)
    const straights = path.filter(isStraight)
    assert.equal(path.length - straights.length, straights.length - 1, `${edge.id}: one rounded corner per turn`)

    path.slice(1).forEach((curve, index) => {
      const before = path[index]
      assert.ok(before !== undefined)
      const [ax, ay] = tangentAt(before, 1)
      const [bx, by] = tangentAt(curve, 0)
      assert.ok(ax * bx + ay * by > 0.999, `${edge.id} has no sharp corner`)
    })

    const route = state.layout.edges.get(edge.id)

    if (straights.length === 3 && route !== undefined) {
      const vertical = route.from.ny !== 0
      const axis = vertical ? 1 : 0
      const middle = straights[1]?.from[axis] ?? 0
      const start = path[0]?.from[axis] ?? 0
      const end = path.at(-1)?.to[axis] ?? 0
      assert.ok(middle > Math.min(start, end) && middle < Math.max(start, end), `${edge.id} stays in its channel`)
    }
  }
})

test("elbows sharing a channel run in lanes of their own", () => {
  const state = controlPlane.stages.at(-1)
  assert.ok(state !== undefined)
  const runs = controlPlane.edges
    .filter((edge) => state.layout.edges.get(edge.id)?.shape === "orthogonal")
    .flatMap((edge) =>
      pathOf(controlPlane, state, edge.id)
        .filter((curve) => isStraight(curve) && Math.abs(curve.from[0] - curve.to[0]) < 0.01)
        .map((curve) => ({
          id: edge.id,
          x: curve.from[0],
          low: Math.min(curve.from[1], curve.to[1]),
          high: Math.max(curve.from[1], curve.to[1]),
        })),
    )
  const lanes = runs.flatMap((run, index) =>
    runs
      .slice(index + 1)
      .filter((other) => other.id !== run.id && other.low < run.high && run.low < other.high)
      .map((other) => ({ pair: `${run.id} / ${other.id}`, apart: Math.abs(other.x - run.x) })),
  )

  assert.ok(lanes.length >= 2, "the fan-out to the engines shares a channel")

  for (const { pair, apart } of lanes) {
    assert.ok(apart >= 13.99, `${pair} are ${apart} apart`)
  }
})

test("a lone edge attaches at its side's centre, and ports along a side follow where their edges go", () => {
  const diagram = defineArchitecture({
    canvas: {
      width: 1200,
      height: 700,
    },
    nodes: {
      source: {
        label: "Source",
      },
      hub: {
        label: "Hub",
        size: [160, 160],
      },
      up: {
        label: "Up",
        row: -1,
      },
      level: {
        label: "Level",
        row: 0,
      },
      down: {
        label: "Down",
        row: 1,
      },
    },
    edges: [
      { from: "source", to: "hub" },
      { from: "hub", to: "down" },
      { from: "hub", to: "up" },
      { from: "hub", to: "level" },
    ],
  })
  const state = diagram.stages[0]
  assert.ok(state !== undefined)

  assert.equal(state.layout.edges.get("source->hub")?.to.v, 0)
  const order = ["hub->up", "hub->level", "hub->down"].map((id) => state.layout.edges.get(id)?.from.v ?? 0)
  assert.deepEqual([...order].sort((a, b) => a - b), order, "top to bottom, as their targets")
  assert.deepEqual(crossingPairs(diagram, state), [])
})
