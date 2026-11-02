import assert from "node:assert/strict"
import { test } from "node:test"

import { edgeGeometry, nodeRect } from "./layout.ts"
import { type ArchitectureDefinition, defineArchitecture, type StageState } from "./model.ts"

const base: ArchitectureDefinition = {
  canvas: {
    width: 1000,
    height: 600,
  },
  flows: {
    create: {
      label: "create instance",
      color: "blue",
    },
  },
  nodes: {
    api: {
      label: "API",
      icon: "workers",
      at: [100, 100],
    },
    engine1: {
      label: "Engine",
      icon: "durable-objects",
      at: [500, 100],
    },
    engine2: {
      label: "Engine",
      at: [500, 300],
    },
    store: {
      label: "Store",
      icon: "database",
      at: [900, 300],
      replicas: 3,
    },
  },
  edges: [
    {
      from: "api",
      to: "engine1",
      flow: "create",
    },
    {
      from: "api",
      to: "engine2",
    },
    {
      from: "engine2",
      to: "store",
      stage: 3,
    },
  ],
  notes: [
    {
      id: "rps",
      text: "About 1k rps",
      at: [300, 500],
    },
  ],
  groups: [
    {
      id: "pool",
      label: "Engines",
      contains: ["engine1", "engine2"],
    },
  ],
  stages: [
    ["api", "rps"],
    ["+engine*", "-rps"],
    ["+store", "flow:create"],
    ["focus:engine2"],
    ["-engine1", "+pool"],
  ],
}

function stage(index: number, definition: ArchitectureDefinition = base): StageState {
  const state = defineArchitecture(definition).stages[index]
  assert.ok(state !== undefined)
  return state
}

function sorted(ids: Iterable<string>): ReadonlyArray<string> {
  return [...ids].sort()
}

/** The base diagram with other stages, and without the edge that waits for stage 3. */
function withStages(stages: ReadonlyArray<ReadonlyArray<string>>): ArchitectureDefinition {
  return {
    ...base,
    edges: base.edges?.filter((edge) => edge.stage === undefined) ?? [],
    stages,
  }
}

test("stages add, wildcard-add, and remove ids cumulatively", () => {
  assert.deepEqual(sorted(stage(0).visible), ["api", "rps"])
  assert.deepEqual(sorted(stage(1).visible), ["api", "api->engine1", "api->engine2", "engine1", "engine2"])
  assert.deepEqual(sorted(stage(4).visible), ["api", "api->engine2", "engine2", "engine2->store", "pool", "store"])
})

test("an edge appears once both ends are shown, or from its own stage", () => {
  assert.ok(!stage(2).visible.has("engine2->store"), "the edge waits for stage 3")
  assert.ok(stage(3).visible.has("engine2->store"))
  assert.ok(!stage(4).visible.has("api->engine1"), "removing an end removes the edge")
})

test("an edge can be hidden and brought back by id", () => {
  const diagram = defineArchitecture(
    withStages([
      ["api", "engine1"],
      ["-api->engine1"],
      ["+api->engine1"],
    ]),
  )

  assert.deepEqual(
    diagram.stages.map((state) => state.visible.has("api->engine1")),
    [true, false, true],
  )
})

test("a flow spotlight lights its edges and their ends for one stage", () => {
  const { spotlight, lit } = stage(2)

  assert.deepEqual(spotlight, {
    kind: "flow",
    flow: "create",
    label: "create instance",
  })
  assert.deepEqual(sorted(lit), ["api", "api->engine1", "engine1"])
  assert.equal(stage(4).spotlight, undefined)
})

test("a focus spotlight lights the node, its edges, and its neighbours", () => {
  const { spotlight, lit } = stage(3)

  assert.deepEqual(spotlight, {
    kind: "focus",
    id: "engine2",
  })
  assert.deepEqual(sorted(lit), ["api", "api->engine2", "engine2", "engine2->store", "store"])
})

test("without stages everything is shown at once", () => {
  const { stages: _, ...everything } = withStages([])
  const { stages } = defineArchitecture(everything)

  assert.equal(stages.length, 1)
  assert.equal(stages[0]?.visible.size, 8)
})

test("manual nodes stay put and their edges run border to border with heads and labels", () => {
  const diagram = defineArchitecture({
    ...base,
    layout: "manual",
  })
  const state = diagram.stages[3]
  const edge = diagram.edges.find(({ id }) => id === "api->engine1")
  assert.ok(state !== undefined && edge !== undefined)

  const rect = (id: string) => {
    const view = state.nodes.get(id)
    const center = state.layout.nodes.get(id)
    assert.ok(view !== undefined && center !== undefined)
    return nodeRect(view, center, state.layout.scale)
  }
  const route = state.layout.edges.get(edge.id)
  assert.ok(route !== undefined)

  const api = rect("api")
  const geometry = edgeGeometry(edge, route, api, rect("engine1"))

  assert.deepEqual(state.layout.nodes.get("api"), [100, 100])
  const [curve] = geometry.path
  assert.ok(curve !== undefined)
  assert.ok(curve.from[0] > api.x + api.width, "starts outside the source")
  assert.equal(geometry.heads.length, 1)
  assert.equal(edge.color, "blue")
  assert.ok(Math.abs(geometry.labelPoint[0] - (curve.from[0] + curve.to[0]) / 2) < 1)
  assert.ok(Math.abs(geometry.labelPoint[1] - 100) < 10, "the label sits on the edge")
})

test("set tokens change what a node shows from their stage on", () => {
  const diagram = defineArchitecture(
    withStages([
      ["api", "engine1"],
      [{ set: { engine1: { label: "Engine v2", replicas: 4 } } }],
      ["engine2"],
    ]),
  )
  const labels = diagram.stages.map((state) => state.nodes.get("engine1")?.label)
  const replicas = diagram.stages.map((state) => state.nodes.get("engine1")?.replicas)

  assert.deepEqual(labels, ["Engine", "Engine v2", "Engine v2"])
  assert.deepEqual(replicas, [undefined, 4, 4])
  assert.ok(
    (diagram.stages[1]?.nodes.get("engine1")?.size[0] ?? 0) > (diagram.stages[0]?.nodes.get("engine1")?.size[0] ?? 0),
    "a longer label widens the node",
  )
})

test("stages that differ only in spotlight share one layout", () => {
  const diagram = defineArchitecture(withStages([["api", "engine1"], ["flow:create"], ["engine2"]]))

  assert.equal(diagram.stages[0]?.layout, diagram.stages[1]?.layout)
  assert.notEqual(diagram.stages[1]?.layout, diagram.stages[2]?.layout)
})

test("invalid definitions fail with a message naming the problem", () => {
  const cases: ReadonlyArray<readonly [ArchitectureDefinition, RegExp]> = [
    [withStages([["api", "+nope"]]), /stage 0 token "\+nope" names unknown id "nope"/],
    [withStages([["missing*"]]), /stage 0 token "missing\*" matches no ids/],
    [withStages([["api", "flow:delete"]]), /unknown flow "delete"/],
    [withStages([["api", "flow:create"]]), /no edges shown in this stage/],
    [withStages([["api", "focus:store"]]), /focuses on "store", which is not shown/],
    [withStages([["api", "flow:create", "focus:api"]]), /one spotlight/],
    [withStages([["note:rps"]]), /not a known kind of token/],
    [withStages([["api", { set: { ghost: { label: "Ghost" } } }]]), /stage 0 sets unknown node "ghost"/],
    [withStages([["api", { set: { api: { replicas: 0 } } }]]), /replicas 0/],
    [
      {
        ...base,
        layout: "manual",
        nodes: {
          ...base.nodes,
          api: {
            label: "API",
          },
        },
      },
      /node "api" has no `at`/,
    ],
    [
      {
        ...base,
        notes: [
          {
            id: "floating",
            text: "nowhere",
          },
        ],
      },
      /note "floating" needs `at` or `near`/,
    ],
    [
      {
        ...base,
        nodes: {
          ...base.nodes,
          api: {
            label: "API",
            below: "ghost",
          },
        },
      },
      /node "api" has below "ghost", which is not a node/,
    ],
    [
      {
        ...base,
        nodes: {
          ...base.nodes,
          api: {
            label: "API",
            replaces: "api",
          },
        },
      },
      /node "api" has replaces "api", which is itself/,
    ],
    [withStages([]), /`stages` is empty/],
    [
      {
        ...base,
        edges: [
          {
            from: "api",
            to: "ghost",
          },
        ],
      },
      /edge "api->ghost" joins unknown node "ghost"/,
    ],
    [
      {
        ...base,
        edges: [
          {
            from: "api",
            to: "store",
          },
          {
            from: "api",
            to: "store",
            label: "again",
          },
        ],
      },
      /id "api->store" is used twice/,
    ],
    [
      {
        ...base,
        notes: [
          {
            id: "api",
            text: "clash",
            at: [0, 0],
          },
        ],
      },
      /id "api" is used twice/,
    ],
    [
      {
        ...base,
        edges: [
          {
            from: "api",
            to: "store",
            flow: "list",
          },
        ],
      },
      /unknown flow "list"/,
    ],
    [
      {
        ...base,
        edges: [
          {
            from: "api",
            to: "store",
            stage: 9,
          },
        ],
      },
      /has stage 9; there are stages 0 to 4/,
    ],
    [
      {
        ...base,
        nodes: {
          ...base.nodes,
          api: {
            label: "API",
            icon: "lambda",
            at: [0, 0],
          },
        },
      },
      /unknown icon "lambda"/,
    ],
    [
      {
        ...base,
        groups: [
          {
            id: "cp",
            label: "Control plane",
            contains: ["api", "ghost"],
          },
        ],
      },
      /group "cp" contains unknown node "ghost"/,
    ],
  ]

  for (const [definition, message] of cases) {
    assert.throws(() => defineArchitecture(definition), message)
  }
})
