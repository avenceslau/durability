import assert from "node:assert/strict"
import { test } from "node:test"

import type { Point } from "./geometry.ts"
import { defineArchitecture } from "./model.ts"
import { type SnapItem, snapPositions } from "./snap.ts"

function item(id: string, point: Point, anchor = true): SnapItem {
  return {
    id,
    point,
    size: [100, 60],
    anchor,
  }
}

function at(positions: ReadonlyMap<string, Point>, id: string): Point {
  const point = positions.get(id)
  assert.ok(point !== undefined, `${id} has a position`)
  return point
}

test("coordinates within the tolerance share a row and a column", () => {
  const positions = snapPositions(
    [item("a", [100, 92]), item("b", [470, 110]), item("c", [480, 270]), item("d", [118, 262]), item("e", [900, 95])],
    40,
  )

  assert.equal(at(positions, "a")[1], at(positions, "b")[1])
  assert.equal(at(positions, "a")[1], at(positions, "e")[1])
  assert.equal(at(positions, "c")[1], at(positions, "d")[1])
  assert.equal(at(positions, "b")[0], at(positions, "c")[0])
  assert.equal(at(positions, "a")[0], at(positions, "d")[0])
})

test("coordinates further apart than the tolerance stay apart", () => {
  const positions = snapPositions([item("a", [100, 100]), item("b", [160, 400])], 40)

  assert.deepEqual(at(positions, "a"), [100, 100])
  assert.deepEqual(at(positions, "b"), [160, 400])
})

test("a row snaps to its nodes, not to a note beside them", () => {
  const positions = snapPositions([item("a", [100, 90]), item("b", [400, 90]), item("note", [700, 120], false)], 40)

  assert.equal(at(positions, "a")[1], 90)
  assert.equal(at(positions, "note")[1], 90)
})

test("nearly even gaps become even, uneven ones stay", () => {
  const even = snapPositions([item("a", [0, 0]), item("b", [200, 0]), item("c", [420, 0]), item("d", [610, 0])], 10)

  assert.deepEqual(
    ["a", "b", "c", "d"].map((id) => Math.round(at(even, id)[0])),
    [0, 203, 407, 610],
  )

  const uneven = snapPositions([item("a", [0, 0]), item("b", [200, 0]), item("c", [700, 0])], 10)
  assert.deepEqual(
    ["a", "b", "c"].map((id) => at(uneven, id)[0]),
    [0, 200, 700],
  )
})

test("snapping never pushes two boxes into each other", () => {
  // One just below and right of the other: snapping both axes would stack them on one spot.
  const positions = snapPositions([item("a", [100, 100]), item("b", [130, 165]), item("c", [400, 100])], 70)

  const a = at(positions, "a")
  const b = at(positions, "b")

  assert.ok(Math.abs(a[0] - b[0]) * 2 >= 200 || Math.abs(a[1] - b[1]) * 2 >= 120, "the boxes still don't overlap")
  assert.ok(
    (a[0] === 100 && a[1] === 100) || (b[0] === 130 && b[1] === 165),
    "one of the two goes back to where it was drawn",
  )
  assert.equal(at(positions, "c")[1], 100, "items that don't collide still snap")
})

test("manual diagrams snap by default, and snap: false keeps the coordinates as drawn", () => {
  const definition = {
    canvas: {
      width: 1600,
      height: 700,
    },
    layout: "manual",
    nodes: {
      a: {
        label: "A",
        at: [100, 92],
      },
      b: {
        label: "B",
        at: [470, 110],
      },
      c: {
        label: "C",
        at: [850, 88],
      },
    },
  } as const
  const snapped = defineArchitecture(definition).stages[0]?.layout.nodes
  const drawn = defineArchitecture({
    ...definition,
    snap: false,
  }).stages[0]?.layout.nodes

  assert.ok(snapped !== undefined && drawn !== undefined)
  assert.equal(new Set([...snapped.values()].map(([, y]) => y)).size, 1, "one row")
  assert.deepEqual(drawn.get("b"), [470, 110])
})
