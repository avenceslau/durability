import assert from "node:assert/strict"
import { test } from "node:test"

import { arrowHead, type Curve, curveLength, type Point, pointOnCurve, subCurve, tangentAt } from "./geometry.ts"

function assertNear(actual: Point, expected: Point, tolerance = 0.01): void {
  assert.ok(
    Math.abs(actual[0] - expected[0]) < tolerance && Math.abs(actual[1] - expected[1]) < tolerance,
    `expected ${expected.join(", ")}, got ${actual.join(", ")}`,
  )
}

const straight: Curve = {
  from: [0, 0],
  c1: [100, 0],
  c2: [200, 0],
  to: [300, 0],
}

const bowed: Curve = {
  from: [0, 0],
  c1: [50, -120],
  c2: [150, -120],
  to: [200, 0],
}

test("a straight cubic runs along its chord", () => {
  assertNear(pointOnCurve(straight, 0.5), [150, 0])
  assertNear(tangentAt(straight, 0.3), [1, 0])
  assert.ok(Math.abs(curveLength(straight) - 300) < 0.01)
})

test("a sub-curve keeps the points of the original curve", () => {
  const part = subCurve(bowed, 0.25, 0.75)

  assertNear(part.from, pointOnCurve(bowed, 0.25))
  assertNear(part.to, pointOnCurve(bowed, 0.75))
  assertNear(pointOnCurve(part, 0.5), pointOnCurve(bowed, 0.5))
})

test("the tangent falls back to the chord where a control point sits on an end", () => {
  const degenerate: Curve = {
    from: [0, 0],
    c1: [0, 0],
    c2: [100, 100],
    to: [100, 100],
  }

  assertNear(tangentAt(degenerate, 0), [Math.SQRT1_2, Math.SQRT1_2])
})

test("an arrowhead's tip is at the end and its base is behind it", () => {
  const [left, tip, right] = arrowHead([100, 0], [1, 0], 15, 7.5)

  assertNear(tip, [100, 0])
  assertNear(left, [85, 7.5])
  assertNear(right, [85, -7.5])
})
