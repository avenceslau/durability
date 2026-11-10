export type Point = readonly [number, number]

/** An axis-aligned rounded rectangle; `x` and `y` are its top-left corner. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly radius: number
}

/** A cubic Bézier curve; a straight edge has its control points on the chord. */
export interface Curve {
  readonly from: Point
  readonly c1: Point
  readonly c2: Point
  readonly to: Point
}

/** Cubic Béziers joined end to start: a single curve, or the straight runs and rounded corners of an elbow. */
export type Path = ReadonlyArray<Curve>

export function expandRect(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + 2 * by,
    height: rect.height + 2 * by,
    radius: rect.radius + by,
  }
}

export function rectCenter(rect: Rect): Point {
  return [rect.x + rect.width / 2, rect.y + rect.height / 2]
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]
}

export function pointOnCurve({ from, c1, c2, to }: Curve, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t

  return [
    a * from[0] + b * c1[0] + c * c2[0] + d * to[0],
    a * from[1] + b * c1[1] + c * c2[1] + d * to[1],
  ]
}

/** The unit tangent at `t`, pointing in the direction of travel. */
export function tangentAt({ from, c1, c2, to }: Curve, t: number): Point {
  const u = 1 - t
  let dx = 3 * u * u * (c1[0] - from[0]) + 6 * u * t * (c2[0] - c1[0]) + 3 * t * t * (to[0] - c2[0])
  let dy = 3 * u * u * (c1[1] - from[1]) + 6 * u * t * (c2[1] - c1[1]) + 3 * t * t * (to[1] - c2[1])

  // A control point on an end point leaves no derivative there; the chord still gives the direction.
  if (Math.hypot(dx, dy) < 1e-6) {
    dx = to[0] - from[0]
    dy = to[1] - from[1]
  }

  const length = Math.hypot(dx, dy) || 1

  return [dx / length, dy / length]
}

/** De Casteljau split at `t`: the curve before and after the point. */
function split(curve: Curve, t: number): readonly [Curve, Curve] {
  const ab = lerpPoint(curve.from, curve.c1, t)
  const bc = lerpPoint(curve.c1, curve.c2, t)
  const cd = lerpPoint(curve.c2, curve.to, t)
  const abc = lerpPoint(ab, bc, t)
  const bcd = lerpPoint(bc, cd, t)
  const middle = lerpPoint(abc, bcd, t)

  return [
    {
      from: curve.from,
      c1: ab,
      c2: abc,
      to: middle,
    },
    {
      from: middle,
      c1: bcd,
      c2: cd,
      to: curve.to,
    },
  ]
}

/** The part of the curve between `t0` and `t1`, still a cubic. */
export function subCurve(curve: Curve, t0: number, t1: number): Curve {
  const [, tail] = split(curve, t0)

  if (t0 >= 1) {
    return tail
  }

  return split(tail, (t1 - t0) / (1 - t0))[0]
}

export function curveLength(curve: Curve): number {
  let length = 0
  let previous = curve.from

  for (let index = 1; index <= 24; index += 1) {
    const point = pointOnCurve(curve, index / 24)
    length += Math.hypot(point[0] - previous[0], point[1] - previous[1])
    previous = point
  }

  return length
}

/** A straight segment as a cubic, so it joins the curves of a path. */
export function lineCurve(from: Point, to: Point): Curve {
  return {
    from,
    c1: lerpPoint(from, to, 1 / 3),
    c2: lerpPoint(from, to, 2 / 3),
    to,
  }
}

export function isStraight({ from, c1, c2, to }: Curve): boolean {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy) || 1
  const off = (point: Point): number => Math.abs((point[0] - from[0]) * dy - (point[1] - from[1]) * dx) / length

  return off(c1) < 0.01 && off(c2) < 0.01
}

export function pathLength(path: Path): number {
  return path.reduce((sum, curve) => sum + curveLength(curve), 0)
}

/**
 * The segment `t` (0 to 1, by length along the whole path) falls in, and how far through it. Within a segment
 * the curve's own parameter stands in for length, so a one-curve path reads exactly as that curve.
 */
function locate(path: Path, t: number): readonly [Curve, number, number] {
  const lengths = path.map(curveLength)
  const total = lengths.reduce((sum, length) => sum + length, 0)
  let remaining = Math.min(Math.max(t, 0), 1) * total

  for (const [index, length] of lengths.entries()) {
    const curve = path[index]

    if (curve !== undefined && (remaining <= length || index === path.length - 1)) {
      return [curve, index, length === 0 ? 0 : Math.min(remaining / length, 1)]
    }

    remaining -= length
  }

  const empty: Curve = {
    from: [0, 0],
    c1: [0, 0],
    c2: [0, 0],
    to: [0, 0],
  }
  return [empty, 0, 0]
}

export function pointOnPath(path: Path, t: number): Point {
  const [curve, , local] = locate(path, t)
  return pointOnCurve(curve, local)
}

export function tangentOnPath(path: Path, t: number): Point {
  const [curve, , local] = locate(path, t)
  return tangentAt(curve, local)
}

/** The part of the path between `t0` and `t1`, by length. */
export function subPath(path: Path, t0: number, t1: number): Path {
  const [first, start, a] = locate(path, t0)
  const [last, end, b] = locate(path, t1)

  if (start === end) {
    return [subCurve(first, a, b)]
  }

  return [subCurve(first, a, 1), ...path.slice(start + 1, end), subCurve(last, 0, b)]
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

export function pathData(path: Path): string {
  const start = path[0]?.from ?? [0, 0]
  const curves = path.map(({ c1, c2, to }) => `C${[c1, c2, to].map(([x, y]) => `${round(x)} ${round(y)}`).join(" ")}`)
  return `M${round(start[0])} ${round(start[1])}${curves.join("")}`
}

export function roundedRectPath({ x, y, width, height, radius }: Rect): string {
  const r = Math.min(radius, width / 2, height / 2)

  return [
    `M${x + r} ${y}`,
    `H${x + width - r}`,
    `A${r} ${r} 0 0 1 ${x + width} ${y + r}`,
    `V${y + height - r}`,
    `A${r} ${r} 0 0 1 ${x + width - r} ${y + height}`,
    `H${x + r}`,
    `A${r} ${r} 0 0 1 ${x} ${y + height - r}`,
    `V${y + r}`,
    `A${r} ${r} 0 0 1 ${x + r} ${y}`,
    "Z",
  ].join("")
}

/** The three corners of an arrowhead whose tip is at `tip`, pointing along the unit vector `direction`. */
export function arrowHead(tip: Point, direction: Point, length: number, halfWidth: number): [Point, Point, Point] {
  const [dx, dy] = direction
  const baseX = tip[0] - dx * length
  const baseY = tip[1] - dy * length

  return [
    [baseX - dy * halfWidth, baseY + dx * halfWidth],
    tip,
    [baseX + dy * halfWidth, baseY - dx * halfWidth],
  ]
}
