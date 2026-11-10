import assert from "node:assert/strict"
import { test } from "node:test"

import { pointOnPath, type Rect } from "./geometry.ts"
import { crossings, edgeGeometry, nodeRect } from "./layout.ts"
import {
  type ArchitectureDefinition,
  type CompositeClicks,
  clickComposite,
  defineArchitecture,
  shownStage,
  type StageState,
} from "./model.ts"

const limiter: ArchitectureDefinition = {
  canvas: {
    width: 1600,
    height: 900,
  },
  nodes: {
    controller: {
      label: "Controller",
      icon: "workers",
    },
    limiter: {
      label: "Limiter",
      icon: "shield",
      contains: ["rateLimit", "bouncer"],
      collapsed: true,
    },
    rateLimit: {
      label: "RateLimiting",
      icon: "shield",
    },
    bouncer: {
      label: "Bouncer",
      icon: "durable-objects",
    },
    engine: {
      label: "Engine Instance",
      icon: "durable-objects",
    },
  },
  edges: [
    {
      from: "controller",
      to: "rateLimit",
    },
    {
      from: "controller",
      to: "bouncer",
    },
    {
      from: "rateLimit",
      to: "bouncer",
      label: "account + workflowId",
    },
    {
      from: "bouncer",
      to: "engine",
      label: "account + workflow + instance ids",
    },
  ],
  stages: [["controller", "limiter", "engine"], ["expand:limiter"], ["collapse:limiter"]],
}

function stages(definition: ArchitectureDefinition = limiter): ReadonlyArray<StageState> {
  return defineArchitecture(definition).stages
}

function edgeEnds(state: StageState): ReadonlyArray<string> {
  return [...state.ends]
    .filter(([id]) => state.visible.has(id))
    .map(([, [from, to]]) => `${from}->${to}`)
    .sort()
}

test("a collapsed composite draws as one box that takes over its children's edges, once per pair of ends", () => {
  const [collapsed] = stages()
  assert.ok(collapsed !== undefined)

  assert.ok(collapsed.visible.has("limiter"))
  assert.ok(!collapsed.visible.has("rateLimit"))
  assert.ok(!collapsed.visible.has("bouncer"))
  assert.deepEqual(edgeEnds(collapsed), ["controller->limiter", "limiter->engine"])
  assert.ok(collapsed.layout.nodes.has("limiter"))
  assert.ok(!collapsed.layout.groups.has("limiter"))
})

test("re-targeted edges keep their labels, and edges inside a collapsed composite are hidden", () => {
  const [collapsed] = stages()
  assert.ok(collapsed !== undefined)

  assert.ok(collapsed.visible.has("bouncer->engine"))
  assert.ok(!collapsed.visible.has("rateLimit->bouncer"))
  assert.deepEqual(collapsed.ends.get("bouncer->engine"), ["limiter", "engine"], "the edge keeps its id, and so its label")
  assert.ok(collapsed.layout.edges.has("bouncer->engine"))
  assert.ok(!collapsed.visible.has("controller->bouncer"), "the duplicate of controller->rateLimit is dropped")
})

test("an expanded composite draws as a group round its children, which take their own edges", () => {
  const [, expanded, collapsedAgain] = stages()
  assert.ok(expanded !== undefined && collapsedAgain !== undefined)

  assert.ok(expanded.expanded.has("limiter"))
  assert.ok(expanded.layout.groups.has("limiter"))
  assert.ok(!expanded.layout.nodes.has("limiter"))
  assert.deepEqual(edgeEnds(expanded), [
    "bouncer->engine",
    "controller->bouncer",
    "controller->rateLimit",
    "rateLimit->bouncer",
  ])
  assert.deepEqual(edgeEnds(collapsedAgain), ["controller->limiter", "limiter->engine"])
})

test("a composite without `collapsed` starts expanded, and stageWith overrides a stage's composites", () => {
  const open = defineArchitecture({
    ...limiter,
    nodes: {
      ...limiter.nodes,
      limiter: {
        label: "Limiter",
        contains: ["rateLimit", "bouncer"],
      },
    },
    stages: [["controller", "limiter", "engine"]],
  })
  assert.ok(open.stages[0]?.expanded.has("limiter"))

  const diagram = defineArchitecture(limiter)
  const clicked = diagram.stageWith(0, new Set(["limiter"]))
  assert.ok(clicked.layout.groups.has("limiter"))
  assert.equal(diagram.stageWith(0, new Set()), diagram.stages[0], "the stage's own state is reused")
  assert.equal(diagram.stageWith(0, new Set(["limiter"])), clicked, "variants are cached")
})

test("a click holds through every build after it, over the builds' own expand: and collapse: tokens", () => {
  const diagram = defineArchitecture(limiter)
  const openAt = (clicks: CompositeClicks): ReadonlyArray<boolean> =>
    diagram.stages.map((_, index) => shownStage(diagram, index, clicks).expanded.has("limiter"))

  assert.deepEqual(openAt(new Map()), [false, true, false], "unclicked, the tokens apply")
  assert.equal(shownStage(diagram, 1, new Map()), diagram.stages[1])

  const opened = clickComposite(new Map(), shownStage(diagram, 0, new Map()), "limiter")
  assert.deepEqual(openAt(opened), [true, true, true], "opened on the first build, it stays open")

  const closed = clickComposite(opened, shownStage(diagram, 1, opened), "limiter")
  assert.deepEqual(openAt(closed), [false, false, false], "closed again, expand:limiter no longer opens it")
  assert.ok(shownStage(diagram, 1, closed).layout.nodes.has("limiter"))
})

test("composites reject nesting, sharing, unknown tokens, and naming their children in stages", () => {
  const cases: ReadonlyArray<readonly [ArchitectureDefinition, RegExp]> = [
    [
      {
        ...limiter,
        nodes: {
          ...limiter.nodes,
          outer: {
            label: "Outer",
            contains: ["limiter"],
          },
        },
      },
      /composite "limiter" is inside composite "outer"; composites nest one level deep only/,
    ],
    [
      {
        ...limiter,
        nodes: {
          ...limiter.nodes,
          other: {
            label: "Other",
            contains: ["bouncer"],
          },
        },
      },
      /node "bouncer" is in composites/,
    ],
    [
      {
        ...limiter,
        stages: [["controller", "expand:engine"]],
      },
      /names "engine", which is not a composite/,
    ],
    [
      {
        ...limiter,
        stages: [["controller", "bouncer"]],
      },
      /inside composite "limiter"/,
    ],
  ]

  for (const [definition, message] of cases) {
    assert.throws(() => defineArchitecture(definition), message)
  }
})

function rectOf(state: StageState, id: string): Rect {
  const view = state.nodes.get(id)
  const center = state.layout.nodes.get(id)
  assert.ok(view !== undefined && center !== undefined, `${id} is placed`)
  return nodeRect(view, center, state.layout.scale)
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

test("both states lay out without overlaps or crossings, and the neighbours keep their order", () => {
  const diagram = defineArchitecture(limiter)

  for (const [index, state] of diagram.stages.entries()) {
    const shown = [...state.layout.nodes.keys()].filter((id) => state.visible.has(id))
    const rects = shown.map((id) => [id, rectOf(state, id)] as const)

    for (const [position, [id, rect]] of rects.entries()) {
      for (const [other, otherRect] of rects.slice(position + 1)) {
        assert.ok(!overlaps(rect, otherRect), `stage ${index}: ${id} overlaps ${other}`)
      }
    }

    const lines = diagram.edges
      .filter((edge) => state.visible.has(edge.id))
      .map((edge) => {
        const [from, to] = state.ends.get(edge.id) ?? [edge.from, edge.to]
        const route = state.layout.edges.get(edge.id)
        assert.ok(route !== undefined)
        const { path } = edgeGeometry(edge, route, rectOf(state, from), rectOf(state, to))
        return Array.from({ length: 81 }, (_, step) => pointOnPath(path, step / 80))
      })

    for (const [position, line] of lines.entries()) {
      for (const other of lines.slice(position + 1)) {
        assert.equal(crossings(line, other), 0, `stage ${index}: edges cross`)
      }
    }

    const xs = shown.map((id) => [id, state.layout.nodes.get(id)?.[0] ?? 0] as const).sort((a, b) => a[1] - b[1])
    assert.equal(xs[0]?.[0], "controller", `stage ${index}: the controller stays first`)
    assert.equal(xs.at(-1)?.[0], "engine", `stage ${index}: the engine stays last`)
  }

  const expanded = diagram.stages[1]
  const group = expanded?.layout.groups.get("limiter")
  assert.ok(expanded !== undefined && group !== undefined)

  for (const id of ["rateLimit", "bouncer"]) {
    const rect = rectOf(expanded, id)
    assert.ok(rect.x > group.x && rect.x + rect.width < group.x + group.width, `${id} sits inside the group`)
  }

  for (const id of ["controller", "engine"]) {
    assert.ok(!overlaps(rectOf(expanded, id), group), `${id} stays outside the group`)
  }
})
