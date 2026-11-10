import {
  arrowHead,
  type Curve,
  curveLength,
  expandRect,
  isStraight,
  lerp,
  lineCurve,
  type Path,
  pathLength,
  type Point,
  pointOnCurve,
  pointOnPath,
  type Rect,
  rectCenter,
  subPath,
  tangentOnPath,
} from "./geometry.ts"
import type { DiagramEdge, DiagramGroup, DiagramNode, DiagramNote, EdgeShape, NodeView } from "./model.ts"

/** Node metrics in canvas units, shared by layout and rendering. */
export const NODE = {
  height: 72,
  radius: 14,
  padding: 18,
  icon: 36,
  iconGap: 14,
  topIcon: 48,
  labelSize: 23,
  sublabelSize: 17,
  replicaOffset: 9,
} as const

export const LABEL = {
  size: 19,
  lineHeight: 23,
} as const

export const NOTE = {
  size: 19,
  lineHeight: 25,
} as const

export const GROUP = {
  padding: 22,
  labelSpace: 26,
  radius: 22,
} as const

const EDGE_GAP = 7
const HEAD_LENGTH = 15
const HEAD_HALF_WIDTH = 7.5
const MARGIN = 28
const MIN_RANK_GAP = 90
const MAX_RANK_GAP = 200
const CROSS_GAP = 44
const NOTE_GAP = 18
/**
 * Gaps between neighbouring ports, as wanted and at the least: two arrowheads want two head widths and need one,
 * so they never overlap.
 */
const PORT_GAP = {
  heads: [HEAD_HALF_WIDTH * 4, HEAD_HALF_WIDTH * 2],
  head: [HEAD_HALF_WIDTH * 3, HEAD_HALF_WIDTH + 3],
  plain: [16, 6],
} as const
/** Space between a label and its neighbours: other labels, and the lines of parallel edges. */
const LABEL_PAD = 8
/** Ports stay this far beyond a side's rounded corner, on its straight part. */
const PORT_INSET = 1
const CORNER = 12
const LANE = 14
/** Puts a cubic's control points where it best follows a quarter circle. */
const KAPPA = 0.5523

/** Where an edge leaves or enters a node: `u`, `v` from −1 to 1 across the rect, and the outward normal. */
export interface Port {
  readonly u: number
  readonly v: number
  readonly nx: number
  readonly ny: number
}

/**
 * How an edge is drawn between two rects, independent of where they are, so it can follow nodes as they move: it
 * leaves and enters through fixed points on the rects' sides, as a curve bowed sideways by `bend`, a straight
 * line, or an elbow whose middle run crosses the gap between them `mid` of the way from start to end.
 */
export interface EdgeRoute {
  readonly shape: EdgeShape
  readonly from: Port
  readonly to: Port
  readonly bend: number
  readonly mid: number
  /** Where the label sits along the edge, from 0 to 1. */
  readonly labelT: number
  /** Moves the label off the line, beside an edge too short to carry it. */
  readonly labelOffset: Point
}

export interface StageLayout {
  /** Applied to node, label, and note sizes so the drawing fits the canvas. */
  readonly scale: number
  /** Node centres. */
  readonly nodes: ReadonlyMap<string, Point>
  /** Note centres. */
  readonly notes: ReadonlyMap<string, Point>
  readonly groups: ReadonlyMap<string, Rect>
  readonly edges: ReadonlyMap<string, EdgeRoute>
}

export interface EdgeGeometry {
  /** From border to border, tip to tip; packets travel along it. */
  readonly path: Path
  /** The stroke, stopping inside the arrowheads so its cap never pokes past their tips. */
  readonly line: Path
  readonly heads: ReadonlyArray<readonly [Point, Point, Point]>
  readonly labelPoint: Point
}

export interface LayoutRequest {
  readonly canvas: {
    readonly width: number
    readonly height: number
  }
  readonly mode: "auto" | "manual"
  readonly direction: "right" | "down"
  readonly routing: "auto" | EdgeShape
  /** Shown nodes, in definition order. */
  readonly nodes: ReadonlyArray<DiagramNode>
  /** What every node shows in this stage. */
  readonly views: ReadonlyMap<string, NodeView>
  readonly edges: ReadonlyArray<DiagramEdge>
  readonly notes: ReadonlyArray<DiagramNote>
  readonly groups: ReadonlyArray<DiagramGroup>
  /** Seeds the order within each rank, so nodes keep their places relative to each other between stages. */
  readonly previous: StageLayout | undefined
  /** Canvas positions of placed nodes and notes (`at` and `pin`), already snapped into line. */
  readonly pins: ReadonlyMap<string, Point>
}

/** A rough width for a label: diagrams are laid out before any font loads, so this errs wide. */
export function textWidth(text: string, size: number): number {
  return Math.max(...text.split("\n").map((line) => line.length)) * size * 0.5
}

export function noteSize(text: string): readonly [number, number] {
  return [textWidth(text, NOTE.size), text.split("\n").length * NOTE.lineHeight]
}

export function labelSize(text: string): readonly [number, number] {
  return [textWidth(text, LABEL.size) + 14, text.split("\n").length * LABEL.lineHeight + 8]
}

/** How far a stack's back cards rise up and to the right of the front one. */
export function stackOffset(replicas: number | undefined): number {
  return Math.min((replicas ?? 1) - 1, 2) * NODE.replicaOffset
}

export function nodeRect(view: NodeView, center: Point, scale: number): Rect {
  const width = view.size[0] * scale
  const height = view.size[1] * scale

  return {
    x: center[0] - width / 2,
    y: center[1] - height / 2,
    width,
    height,
    radius: NODE.radius * scale,
  }
}

/** The node's rect grown to cover its stack's back cards. */
function footprint(view: NodeView, center: Point, scale: number): Rect {
  const rect = nodeRect(view, center, scale)
  const stack = stackOffset(view.replicas) * scale

  return {
    ...rect,
    y: rect.y - stack,
    width: rect.width + stack,
    height: rect.height + stack,
  }
}

function centeredRect([x, y]: Point, [width, height]: readonly [number, number]): Rect {
  return {
    x: x - width / 2,
    y: y - height / 2,
    width,
    height,
    radius: 0,
  }
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)

  return width > 0 && height > 0 ? width * height : 0
}

function boundingRect(rects: ReadonlyArray<Rect>): Rect | undefined {
  if (rects.length === 0) {
    return undefined
  }

  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    radius: 0,
  }
}

function groupRect(members: ReadonlyArray<Rect>, scale: number): Rect | undefined {
  const box = boundingRect(members)

  if (box === undefined) {
    return undefined
  }

  const padding = GROUP.padding * scale
  const top = (GROUP.padding + GROUP.labelSpace) * scale

  return {
    x: box.x - padding,
    y: box.y - top,
    width: box.width + padding * 2,
    height: box.height + padding + top,
    radius: GROUP.radius * scale,
  }
}

/**
 * Boxes round each group's member rects, smaller groups first: a group whose members all sit in another group
 * goes round that one's box too, so nested boxes never share an edge.
 */
function groupBoxes(
  groups: ReadonlyArray<DiagramGroup>,
  memberRects: (group: DiagramGroup) => ReadonlyArray<Rect>,
  scale: number,
): Map<string, Rect> {
  const boxes = new Map<string, Rect>()
  const smallestFirst = [...groups].sort((a, b) => a.contains.length - b.contains.length)

  for (const group of smallestFirst) {
    const inner = smallestFirst.flatMap((other) => {
      const box = boxes.get(other.id)
      return other !== group && box !== undefined && other.contains.every((id) => group.contains.includes(id)) ? [box] : []
    })
    const rect = groupRect([...memberRects(group), ...inner], scale)

    if (rect !== undefined) {
      boxes.set(group.id, rect)
    }
  }

  return new Map(groups.flatMap((group) => {
    const box = boxes.get(group.id)
    return box === undefined ? [] : [[group.id, box] as const]
  }))
}

function addPoints(a: Point, b: Point): Point {
  return [a[0] + b[0], a[1] + b[1]]
}

function attach(rect: Rect, port: Port): Point {
  return [
    rect.x + ((port.u + 1) / 2) * rect.width + port.nx * EDGE_GAP,
    rect.y + ((port.v + 1) / 2) * rect.height + port.ny * EDGE_GAP,
  ]
}

function leavesVertically(port: Port): boolean {
  return Math.abs(port.ny) > Math.abs(port.nx)
}

/** The corners an elbow turns at, from end to end: one corner between crossing sides, two between facing ones. */
function elbowPoints(route: EdgeRoute, from: Point, to: Point): ReadonlyArray<Point> {
  const vertical = leavesVertically(route.from)

  if (vertical !== leavesVertically(route.to)) {
    return [from, vertical ? [from[0], to[1]] : [to[0], from[1]], to]
  }

  const across = vertical ? 0 : 1

  // A jog of a pixel or two would show as a kink.
  if (Math.abs(to[across] - from[across]) < 2) {
    return [from, to]
  }

  if (vertical) {
    const y = lerp(from[1], to[1], route.mid)
    return [from, [from[0], y], [to[0], y], to]
  }

  const x = lerp(from[0], to[0], route.mid)
  return [from, [x, from[1]], [x, to[1]], to]
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/** Straight runs between the corners, each corner rounded by a quarter circle that fits within half its runs. */
function elbowPath(corners: ReadonlyArray<Point>): Path {
  const points = corners.filter((point, index) => {
    const before = corners[index - 1]
    return before === undefined || distance(before, point) > 0.5
  })
  const path: Curve[] = []
  let cursor = points[0] ?? [0, 0]

  for (let index = 1; index < points.length - 1; index += 1) {
    const before = points[index - 1]
    const corner = points[index]
    const after = points[index + 1]

    if (before === undefined || corner === undefined || after === undefined) {
      continue
    }

    const inLength = distance(before, corner)
    const outLength = distance(corner, after)
    const radius = Math.min(CORNER, inLength / 2, outLength / 2)
    const din: Point = [(corner[0] - before[0]) / inLength, (corner[1] - before[1]) / inLength]
    const dout: Point = [(after[0] - corner[0]) / outLength, (after[1] - corner[1]) / outLength]
    const start: Point = [corner[0] - din[0] * radius, corner[1] - din[1] * radius]
    const end: Point = [corner[0] + dout[0] * radius, corner[1] + dout[1] * radius]

    if (distance(cursor, start) > 0.01) {
      path.push(lineCurve(cursor, start))
    }

    path.push({
      from: start,
      c1: [start[0] + din[0] * radius * KAPPA, start[1] + din[1] * radius * KAPPA],
      c2: [end[0] - dout[0] * radius * KAPPA, end[1] - dout[1] * radius * KAPPA],
      to: end,
    })
    cursor = end
  }

  path.push(lineCurve(cursor, points[points.length - 1] ?? cursor))
  return path
}

function routePath(route: EdgeRoute, fromRect: Rect, toRect: Rect): Path {
  const from = attach(fromRect, route.from)
  const to = attach(toRect, route.to)

  if (route.shape === "straight") {
    return [lineCurve(from, to)]
  }

  if (route.shape === "orthogonal") {
    return elbowPath(elbowPoints(route, from, to))
  }

  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  // Control points reach out along each normal for half the distance travelled that way, so aligned ports give
  // a straight line and offset ones a gentle S.
  const reachFrom = Math.min(Math.max(Math.abs(dx * route.from.nx + dy * route.from.ny) / 2, 16), 260)
  const reachTo = Math.min(Math.max(Math.abs(dx * route.to.nx + dy * route.to.ny) / 2, 16), 260)
  // `bend` chord lengths of sideways pull on the control points bows the midpoint by three quarters of that.
  const bowX = ((2 / 3) * route.bend * dy)
  const bowY = ((2 / 3) * route.bend * -dx)

  return [
    {
      from,
      c1: [from[0] + route.from.nx * reachFrom + bowX, from[1] + route.from.ny * reachFrom + bowY],
      c2: [to[0] + route.to.nx * reachTo + bowX, to[1] + route.to.ny * reachTo + bowY],
      to,
    },
  ]
}

/** Where an edge runs between two node rects, with its arrowheads and label point. */
export function edgeGeometry(edge: DiagramEdge, route: EdgeRoute, fromRect: Rect, toRect: Rect): EdgeGeometry {
  const path = routePath(route, fromRect, toRect)
  const trim = Math.min((HEAD_LENGTH * 0.6) / Math.max(pathLength(path), 1), 0.45)
  const start = path[0]?.from ?? [0, 0]
  const end = path[path.length - 1]?.to ?? start
  const heads = [arrowHead(end, tangentOnPath(path, 1), HEAD_LENGTH, HEAD_HALF_WIDTH)]

  if (edge.both) {
    const [dx, dy] = tangentOnPath(path, 0)
    heads.push(arrowHead(start, [-dx, -dy], HEAD_LENGTH, HEAD_HALF_WIDTH))
  }

  return {
    path,
    line: subPath(path, edge.both ? trim : 0, 1 - trim),
    heads,
    labelPoint: addPoints(pointOnPath(path, route.labelT), route.labelOffset),
  }
}

/** Drops the edges that close a cycle, found depth first in definition order, so longest paths exist. */
function acyclic(ids: ReadonlyArray<string>, edges: ReadonlyArray<DiagramEdge>): ReadonlyArray<DiagramEdge> {
  const state = new Map<string, "open" | "done">()
  const dropped = new Set<DiagramEdge>()

  const visit = (id: string): void => {
    state.set(id, "open")

    for (const edge of edges) {
      if (edge.from !== id) {
        continue
      }

      const next = state.get(edge.to)

      if (next === "open") {
        dropped.add(edge)
      } else if (next === undefined) {
        visit(edge.to)
      }
    }

    state.set(id, "done")
  }

  for (const id of ids) {
    if (!state.has(id)) {
      visit(id)
    }
  }

  return edges.filter((edge) => !dropped.has(edge))
}

/**
 * Longest-path ranks over the edges that point forward: `both` and `back` edges, edges closing a cycle, and edges
 * between nodes tied to one rank by `below` or `above` don't count. `rank` fixes a node; `after` acts as an edge;
 * `below` and `above` put a node in its anchor's rank whatever its own edges say.
 * Sources then move up to just before their nearest successor, and empty ranks close up.
 */
export function assignRanks(
  nodes: ReadonlyArray<DiagramNode>,
  edges: ReadonlyArray<DiagramEdge>,
): ReadonlyMap<string, number> {
  const ids = new Set(nodes.map((node) => node.id))
  const fixed = new Set(nodes.filter((node) => node.rank !== undefined).map((node) => node.id))
  const ties = nodes.flatMap((node) => {
    const anchor = node.below ?? node.above
    return anchor !== undefined && ids.has(anchor) ? [[node.id, anchor] as const] : []
  })
  const tied = new Set(ties.flat())
  const followers = new Set(ties.map(([follower]) => follower))
  const isTie = (a: string, b: string): boolean => ties.some(([x, y]) => (x === a && y === b) || (x === b && y === a))

  const candidates = edges.filter(
    (edge) =>
      ids.has(edge.from) &&
      ids.has(edge.to) &&
      edge.from !== edge.to &&
      !edge.both &&
      !edge.back &&
      !isTie(edge.from, edge.to),
  )
  const forward = [
    ...acyclic([...ids], candidates).map((edge) => [edge.from, edge.to] as const),
    ...nodes.flatMap((node) => (node.after !== undefined && ids.has(node.after) ? [[node.after, node.id] as const] : [])),
  ]

  const rank = new Map(nodes.map((node) => [node.id, node.rank ?? 0]))
  const get = (id: string): number => rank.get(id) ?? 0
  // A node placed below or above another takes its anchor's rank; its own edges in don't move it.
  const raise = (id: string, to: number): boolean => {
    if (fixed.has(id) || followers.has(id) || get(id) >= to) {
      return false
    }

    rank.set(id, to)
    return true
  }

  for (let pass = 0; pass <= nodes.length * 2; pass += 1) {
    let changed = false

    for (const [from, to] of forward) {
      changed = raise(to, get(from) + 1) || changed
    }

    for (const [follower, anchor] of ties) {
      if (!fixed.has(follower) && get(follower) !== get(anchor)) {
        rank.set(follower, get(anchor))
        changed = true
      }
    }

    if (!changed) {
      break
    }
  }

  const targets = new Set(forward.map(([, to]) => to))
  const sources = nodes
    .filter((node) => !targets.has(node.id) && !fixed.has(node.id) && !tied.has(node.id))
    .sort((a, b) => get(b.id) - get(a.id))

  for (const node of sources) {
    const next = forward.filter(([from]) => from === node.id).map(([, to]) => get(to))

    if (next.length > 0) {
      rank.set(node.id, Math.max(get(node.id), Math.min(...next) - 1))
    }
  }

  const used = [...new Set(rank.values())].sort((a, b) => a - b)
  return new Map([...rank].map(([id, value]) => [id, used.indexOf(value)]))
}

/** Pool-adjacent-violators: the non-decreasing sequence closest to `values` in weighted least squares. */
function isotonic(values: ReadonlyArray<number>, weights: ReadonlyArray<number>): ReadonlyArray<number> {
  const blocks: Array<{
    value: number
    weight: number
    count: number
  }> = []

  values.forEach((value, index) => {
    blocks.push({
      value,
      weight: weights[index] ?? 1,
      count: 1,
    })

    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]
      const before = blocks[blocks.length - 2]

      if (last === undefined || before === undefined || before.value <= last.value) {
        break
      }

      const weight = before.weight + last.weight
      blocks.splice(-2, 2, {
        value: (before.value * before.weight + last.value * last.weight) / weight,
        weight,
        count: before.count + last.count,
      })
    }
  })

  return blocks.flatMap((block) => Array<number>(block.count).fill(block.value))
}

function mean(values: ReadonlyArray<number>): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length
}

/** The median keeps a chain straight when one neighbour pulls off to the side, where the mean would bend it. */
function median(values: ReadonlyArray<number>): number | undefined {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : mean(sorted.slice(middle - 1, middle + 1))
}

interface RankedGraph {
  readonly nodes: ReadonlyArray<DiagramNode>
  readonly byId: ReadonlyMap<string, DiagramNode>
  readonly ranks: ReadonlyMap<string, number>
  readonly neighbours: ReadonlyMap<string, ReadonlyArray<string>>
  readonly groupOf: ReadonlyMap<string, string>
  /** Every group round a node, nested ones included. */
  readonly groupsOf: ReadonlyMap<string, ReadonlySet<string>>
}

function rankedGraph(
  nodes: ReadonlyArray<DiagramNode>,
  ranks: ReadonlyMap<string, number>,
  edges: ReadonlyArray<DiagramEdge>,
  groups: ReadonlyArray<DiagramGroup>,
): RankedGraph {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const neighbours = new Map(nodes.map((node) => [node.id, [] as string[]]))

  for (const edge of edges) {
    if (edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to)) {
      neighbours.get(edge.from)?.push(edge.to)
      neighbours.get(edge.to)?.push(edge.from)
    }
  }

  const groupOf = new Map<string, string>()
  const groupsOf = new Map<string, Set<string>>()

  for (const group of groups) {
    for (const id of group.contains) {
      if (!groupOf.has(id)) {
        groupOf.set(id, group.id)
      }

      groupsOf.set(id, new Set([...(groupsOf.get(id) ?? []), group.id]))
    }
  }

  return {
    nodes,
    byId,
    ranks,
    neighbours,
    groupOf,
    groupsOf,
  }
}

/**
 * Orders each rank by barycentre over a few sweeps, keeping nodes from the previous stage in their old relative
 * order and members of a group together.
 */
function orderRanks(graph: RankedGraph, previousCross: ReadonlyMap<string, number>): ReadonlyArray<ReadonlyArray<string>> {
  const { nodes, byId, ranks, neighbours, groupOf } = graph
  const rankCount = Math.max(-1, ...ranks.values()) + 1
  const layers: string[][] = Array.from({ length: rankCount }, () => [])
  const initial = [...nodes].sort(
    (a, b) => (previousCross.get(a.id) ?? Infinity) - (previousCross.get(b.id) ?? Infinity),
  )

  for (const node of initial) {
    layers[ranks.get(node.id) ?? 0]?.push(node.id)
  }

  const centred = (id: string): number => {
    const layer = layers[ranks.get(id) ?? 0] ?? []
    return layer.indexOf(id) - (layer.length - 1) / 2
  }

  for (let sweep = 0; sweep < 8; sweep += 1) {
    const down = sweep % 2 === 0
    const order = down ? layers.map((_, index) => index) : layers.map((_, index) => layers.length - 1 - index)

    for (const rank of order) {
      const layer = layers[rank]

      if (layer === undefined) {
        continue
      }

      const side = down ? rank - 1 : rank + 1
      const keys = new Map(
        layer.map((id) => {
          const hint = byId.get(id)?.row
          const all = (neighbours.get(id) ?? []).filter((other) => ranks.get(other) !== rank)
          const adjacent = all.filter((other) => ranks.get(other) === side)
          const key =
            hint !== undefined
              ? hint - (layer.length - 1) / 2
              : (mean(adjacent.map(centred)) ?? mean(all.map(centred)) ?? centred(id))
          return [id, key]
        }),
      )

      for (const [id, group] of groupOf) {
        const members = layer.filter((other) => groupOf.get(other) === group)

        if (members.includes(id)) {
          keys.set(id, mean(members.map((member) => keys.get(member) ?? 0)) ?? 0)
        }
      }

      const key = (id: string): number => keys.get(id) ?? 0
      const kept = layer
        .filter((id) => previousCross.has(id) && byId.get(id)?.row === undefined)
        .sort((a, b) => (previousCross.get(a) ?? 0) - (previousCross.get(b) ?? 0))
      const fresh = layer.filter((id) => !kept.includes(id)).sort((a, b) => key(a) - key(b))
      const merged: string[] = []

      while (kept.length > 0 || fresh.length > 0) {
        const next = fresh[0] !== undefined && (kept[0] === undefined || key(fresh[0]) < key(kept[0])) ? fresh : kept
        merged.push(next.shift() ?? "")
      }

      for (const node of nodes) {
        const anchor = node.below ?? node.above

        if (anchor === undefined || !merged.includes(node.id) || !merged.includes(anchor)) {
          continue
        }

        merged.splice(merged.indexOf(node.id), 1)
        merged.splice(merged.indexOf(anchor) + (node.below === undefined ? 0 : 1), 0, node.id)
      }

      layers[rank] = merged
    }
  }

  return layers
}

/**
 * Places each rank's nodes on a grid of half rows, two apart and in order, as close as they can get to their
 * neighbours in other ranks, so a node with two children sits between them and chains run straight.
 */
function placeRows(
  graph: RankedGraph,
  layers: ReadonlyArray<ReadonlyArray<string>>,
  direction: "right" | "down",
): ReadonlyMap<string, number> {
  const { byId, ranks, neighbours, groupsOf } = graph
  const rows = new Map<string, number>()
  const none = new Set<string>()

  // The gap between two rows has room for one box edge but its padding, or the bottom of a group's box, not its
  // titled top as well; more than that takes an extra half row.
  const spacing = (previous: string | undefined, id: string): number => {
    if (previous === undefined) {
      return 0
    }

    const above = groupsOf.get(previous) ?? none
    const below = groupsOf.get(id) ?? none
    const closing = [...above].filter((group) => !below.has(group)).length
    const opening = [...below].filter((group) => !above.has(group)).length
    const titled = direction === "right" && opening > 0

    return closing + opening > 1 || titled ? 3 : 2
  }

  for (const layer of layers) {
    layer.forEach((id, index) => rows.set(id, index * 2 - (layer.length - 1)))
  }

  for (let sweep = 0; sweep < 8; sweep += 1) {
    const order = sweep % 2 === 0 ? layers : [...layers].reverse()

    for (const layer of order) {
      const desired: number[] = []
      const weights: number[] = []
      const offsets: number[] = []
      let offset = 0

      layer.forEach((id, index) => {
        const node = byId.get(id)
        const anchor = node?.below ?? node?.above
        const others = (neighbours.get(id) ?? []).filter((other) => ranks.get(other) !== ranks.get(id))
        let want = median(others.map((other) => rows.get(other) ?? 0)) ?? rows.get(id) ?? 0
        let weight = 1

        if (anchor !== undefined && rows.has(anchor) && ranks.get(anchor) === ranks.get(id)) {
          want = (rows.get(anchor) ?? 0) + (node?.below === undefined ? -2 : 2)
          weight = 4
        }

        if (node?.row !== undefined) {
          want = node.row * 2
          weight = 50
        }

        offset += spacing(layer[index - 1], id)
        offsets.push(offset)
        desired.push(want - offset)
        weights.push(weight)
      })

      const fitted = isotonic(desired, weights)
      layer.forEach((id, index) => rows.set(id, Math.round(fitted[index] ?? 0) + (offsets[index] ?? 0)))
    }
  }

  return rows
}

function cross(point: Point, direction: "right" | "down"): number {
  return direction === "right" ? point[1] : point[0]
}

/** The point `distance` beyond `rect` on `side`, for a box of `size` centred there. */
function besideRect(rect: Rect, side: "top" | "bottom" | "left" | "right", size: readonly [number, number]): Point {
  const [cx, cy] = rectCenter(rect)

  switch (side) {
    case "top":
      return [cx, rect.y - NOTE_GAP - size[1] / 2]
    case "bottom":
      return [cx, rect.y + rect.height + NOTE_GAP + size[1] / 2]
    case "left":
      return [rect.x - NOTE_GAP - size[0] / 2, cy]
    case "right":
      return [rect.x + rect.width + NOTE_GAP + size[0] / 2, cy]
  }
}

/** Places notes beside their `near` node, trying the preferred side first and then the others. */
function placeNotes(
  notes: ReadonlyArray<DiagramNote>,
  footprints: ReadonlyMap<string, Rect>,
  scale: number,
): Map<string, Point> {
  const placed = new Map<string, Point>()
  const taken = [...footprints.values()]

  for (const note of notes) {
    const size: readonly [number, number] = [note.size[0] * scale, note.size[1] * scale]
    const target = note.near === undefined ? undefined : footprints.get(note.near)

    if (target === undefined) {
      continue
    }

    const preferred = note.side ?? "bottom"
    const sides = [preferred, ...(["bottom", "top", "right", "left"] as const).filter((side) => side !== preferred)]
    const candidates = sides.map((side) => besideRect(target, side, size))
    const score = (point: Point): number =>
      taken.reduce((sum, rect) => sum + overlapArea(rect, centeredRect(point, size)), 0)
    const best = candidates.find((point) => score(point) === 0) ?? candidates[0]

    if (best !== undefined) {
      placed.set(note.id, best)
      taken.push(centeredRect(best, size))
    }
  }

  return placed
}

type Side = "left" | "right" | "top" | "bottom"

const NORMALS: Readonly<Record<Side, Point>> = {
  left: [-1, 0],
  right: [1, 0],
  top: [0, -1],
  bottom: [0, 1],
}

const OPPOSITE: Readonly<Record<Side, Side>> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
}

/** The side an edge leaves by: facing the other node, across the rank gap when there is one. */
function exitSide(from: Rect, to: Rect, direction: "right" | "down"): Side {
  const [fx, fy] = rectCenter(from)
  const [tx, ty] = rectCenter(to)
  const horizontalGap = Math.abs(tx - fx) - (from.width + to.width) / 2
  const verticalGap = Math.abs(ty - fy) - (from.height + to.height) / 2
  const horizontal =
    direction === "right"
      ? horizontalGap > 16 || verticalGap < 0
      : !(verticalGap > 16) && horizontalGap > verticalGap

  if (horizontal) {
    return tx >= fx ? "right" : "left"
  }

  return ty >= fy ? "bottom" : "top"
}

type SidePair = readonly [Side, Side]

const CENTRE_PORT: Port = {
  u: 0,
  v: 0,
  nx: 0,
  ny: 0,
}

/**
 * Edges sharing a side spread out along it, ordered by where each one comes from (`approach`), so an edge arriving
 * from higher up attaches higher and none cross at the node; edges between one pair of nodes stay parallel. A lone
 * edge attaches at the centre. Neighbours sit far enough apart that arrowheads never touch, within the side's
 * straight part, clear of the rounded corners. A short side narrows the gaps towards their least, and only one too
 * short even for that squeezes them closer.
 */
function assignPorts(
  edges: ReadonlyArray<DiagramEdge>,
  rects: ReadonlyMap<string, Rect>,
  sides: ReadonlyArray<SidePair>,
  approach: (edge: number, end: 0 | 1) => Point,
  scale: number,
): ReadonlyArray<readonly [Port, Port]> {
  const ends = new Map<
    string,
    Array<{
      readonly edge: number
      readonly end: 0 | 1
      readonly head: boolean
      readonly headThere: boolean
      readonly toward: Point
    }>
  >()

  edges.forEach((edge, index) => {
    const pair = sides[index]

    if (pair === undefined) {
      return
    }

    for (const end of [0, 1] as const) {
      const key = `${end === 0 ? edge.from : edge.to}|${pair[end]}`
      const list = ends.get(key) ?? []
      list.push({
        edge: index,
        end,
        head: end === 1 || edge.both,
        headThere: end === 0 || edge.both,
        toward: approach(index, end),
      })
      ends.set(key, list)
    }
  })

  const ports = edges.map(() => [CENTRE_PORT, CENTRE_PORT] as [Port, Port])

  for (const [key, list] of ends) {
    const [id = "", side = "right"] = key.split("|") as [string, Side]
    const rect = rects.get(id)

    if (rect === undefined) {
      continue
    }

    const vertical = side === "left" || side === "right"
    const length = vertical ? rect.height : rect.width
    list.sort((a, b) => (vertical ? a.toward[1] - b.toward[1] : a.toward[0] - b.toward[0]) || a.edge - b.edge)

    const pair = (edge: number): string => [edges[edge]?.from, edges[edge]?.to].sort().join("|")
    const labelSpan = (edge: number): number => {
      const label = edges[edge]?.label
      return label === undefined ? 0 : labelSize(label)[vertical ? 1 : 0] * scale
    }
    // Edges joining the same two nodes take the wider gap of their two ends, so they stay parallel, and want room
    // for their labels between them.
    const gaps = list.slice(1).map((entry, index): readonly [number, number] => {
      const before = list[index]
      const parallel = before !== undefined && pair(before.edge) === pair(entry.edge)
      const here = Number(entry.head) + Number(before?.head ?? false)
      const there = parallel ? Number(entry.headThere) + Number(before.headThere) : 0
      const heads = Math.max(here, there)
      const gap = heads === 2 ? PORT_GAP.heads : heads === 1 ? PORT_GAP.head : PORT_GAP.plain
      const labels = parallel ? labelSpan(before.edge) + labelSpan(entry.edge) : 0

      if (labels === 0) {
        return gap
      }

      return [Math.max(gap[0], labels / 2 + LABEL_PAD * scale), gap[1]]
    })
    const wanted = gaps.reduce((sum, [gap]) => sum + gap, 0)
    const least = gaps.reduce((sum, [, gap]) => sum + gap, 0)
    const straight = Math.max(length - 2 * (rect.radius + PORT_INSET), 0)
    const fit = wanted <= straight ? 1 : Math.max((straight - least) / (wanted - least), 0)
    const squeeze = least > straight ? straight / least : 1
    const widths = gaps.map(([want, low]) => (low + (want - low) * fit) * squeeze)
    let offset = -widths.reduce((sum, width) => sum + width, 0) / 2

    list.forEach((entry, index) => {
      offset += index === 0 ? 0 : (widths[index - 1] ?? 0)
      const along = offset / (length / 2)
      const [nx, ny] = NORMALS[side]
      const slot = ports[entry.edge]

      if (slot !== undefined) {
        slot[entry.end] = {
          u: vertical ? nx : along,
          v: vertical ? along : ny,
          nx,
          ny,
        }
      }
    })
  }

  // A side whose edges all run to one node facing it lines them up with their other ends when it can, so a lone
  // elbow runs straight instead of jogging and parallel edges stay level. The end with more edges on its side leads.
  for (const [key, list] of ends) {
    const otherKeys = new Set(
      list.map(({ edge, end }) => {
        const far = end === 0 ? edges[edge]?.to : edges[edge]?.from
        return `${far}|${sides[edge]?.[end === 0 ? 1 : 0]}`
      }),
    )
    const [otherKey = ""] = otherKeys
    const leaders = ends.get(otherKey)
    const [id = "", side = "right"] = key.split("|") as [string, Side]
    const [otherId = "", otherSide = "left"] = otherKey.split("|") as [string, Side]
    const rect = rects.get(id)
    const other = rects.get(otherId)

    if (
      otherKeys.size !== 1 ||
      leaders === undefined ||
      rect === undefined ||
      other === undefined ||
      side !== OPPOSITE[otherSide] ||
      leaders.length < list.length ||
      (leaders.length === list.length && key < otherKey)
    ) {
      continue
    }

    const vertical = side === "left" || side === "right"
    const half = (vertical ? rect.height : rect.width) / 2
    const limit = Math.max(half - rect.radius - PORT_INSET, 0) / half
    const aligned = list.map(({ edge, end }) => {
      const far = ports[edge]?.[end === 0 ? 1 : 0] ?? CENTRE_PORT
      return (attach(other, far)[vertical ? 1 : 0] - rectCenter(rect)[vertical ? 1 : 0]) / half
    })

    // Nodes of one height put the other end's outermost port right at this side's limit.
    if (aligned.some((along) => Math.abs(along) > limit + 1e-6)) {
      continue
    }

    list.forEach(({ edge, end }, index) => {
      const slot = ports[edge]
      const port = slot?.[end]
      const along = aligned[index] ?? 0

      if (slot !== undefined && port !== undefined) {
        slot[end] = {
          ...port,
          u: vertical ? port.u : along,
          v: vertical ? along : port.v,
        }
      }
    })
  }

  return ports
}

function sideOf(port: Port): Side {
  if (port.nx !== 0) {
    return port.nx < 0 ? "left" : "right"
  }

  return port.ny < 0 ? "top" : "bottom"
}

/**
 * Spreads the ports again over only the edges a stage shows. A layout also routes the edges later stages add, so
 * nothing moves when they appear, but their ports would leave a lone edge off its side's centre. Each edge keeps
 * its sides, bend, and place in the order along each side, so none cross; the labels are placed again among the
 * edges shown.
 */
export function spreadPorts(
  layout: StageLayout,
  edges: ReadonlyArray<DiagramEdge>,
  views: ReadonlyMap<string, NodeView>,
  notes: ReadonlyArray<DiagramNote>,
): StageLayout {
  const measured = (measure: typeof nodeRect): Map<string, Rect> =>
    new Map(
      [...layout.nodes].flatMap(([id, centre]) => {
        const view = views.get(id)
        return view === undefined ? [] : [[id, measure(view, centre, layout.scale)] as const]
      }),
    )
  const rects = measured(nodeRect)
  const routed = edges.flatMap((edge) => {
    const route = layout.edges.get(edge.id)
    const from = rects.get(edge.from)
    const to = rects.get(edge.to)
    return route === undefined || from === undefined || to === undefined ? [] : [{ edge, route, from, to }]
  })
  const sides = routed.map(({ route }): SidePair => [sideOf(route.from), sideOf(route.to)])
  // Sorting by where each end attaches in the full layout keeps its order along the side.
  const attached = (index: number, end: 0 | 1): Point => {
    const entry = routed[index]

    if (entry === undefined) {
      return [0, 0]
    }

    return end === 0 ? attach(entry.from, entry.route.from) : attach(entry.to, entry.route.to)
  }
  const ports = assignPorts(
    routed.map(({ edge }) => edge),
    rects,
    sides,
    attached,
    layout.scale,
  )
  const noteRects = notes.flatMap((note) => {
    const centre = layout.notes.get(note.id)
    return centre === undefined ? [] : [centeredRect(centre, [note.size[0] * layout.scale, note.size[1] * layout.scale])]
  })
  const placed = placeLabels(
    routed.map((entry, index) => {
      const [from, to] = ports[index] ?? [entry.route.from, entry.route.to]
      return {
        ...entry,
        route: {
          ...entry.route,
          from,
          to,
        },
      }
    }),
    measured(footprint),
    noteRects,
    layout.scale,
  )

  return {
    ...layout,
    edges: new Map([...layout.edges, ...placed.map((route, index) => [routed[index]?.edge.id ?? "", route] as const)]),
  }
}

/** The other side an edge could use: across the other axis, facing the other node, if it is off to that side. */
function facingSide(self: Rect, other: Rect, side: Side): Side | undefined {
  const [sx, sy] = rectCenter(self)
  const [ox, oy] = rectCenter(other)

  if (side === "left" || side === "right") {
    return oy > sy + 1 ? "bottom" : oy < sy - 1 ? "top" : undefined
  }

  return ox > sx + 1 ? "right" : ox < sx - 1 ? "left" : undefined
}

function sideOptions(from: Rect, to: Rect, primary: SidePair): ReadonlyArray<SidePair> {
  const fromAlternative = facingSide(from, to, primary[0])
  const toAlternative = facingSide(to, from, primary[1])
  const options: Array<readonly [Side | undefined, Side | undefined]> = [
    primary,
    [primary[0], toAlternative],
    [fromAlternative, primary[1]],
    [fromAlternative, toAlternative],
  ]

  return options.flatMap(([a, b]) => (a === undefined || b === undefined ? [] : [[a, b] as const]))
}

const SAMPLES = 12

/** Points along a path: a straight run needs only its ends, a curve a dozen, a rounded corner a few. */
function polyline(path: Path): ReadonlyArray<Point> {
  const points: Point[] = [path[0]?.from ?? [0, 0]]

  for (const curve of path) {
    const steps = isStraight(curve) ? 1 : path.length === 1 ? SAMPLES : 4

    for (let step = 1; step <= steps; step += 1) {
      points.push(pointOnCurve(curve, step / steps))
    }
  }

  return points
}

/** Liang-Barsky: whether the segment from `p` to `q` passes through `rect`. */
function segmentHitsRect(p: Point, q: Point, rect: Rect): boolean {
  const dx = q[0] - p[0]
  const dy = q[1] - p[1]
  const clips = [
    [-dx, p[0] - rect.x],
    [dx, rect.x + rect.width - p[0]],
    [-dy, p[1] - rect.y],
    [dy, rect.y + rect.height - p[1]],
  ] as const
  let enter = 0
  let leave = 1

  for (const [towards, room] of clips) {
    if (towards === 0) {
      if (room < 0) {
        return false
      }

      continue
    }

    const t = room / towards

    if (towards < 0) {
      enter = Math.max(enter, t)
    } else {
      leave = Math.min(leave, t)
    }
  }

  return enter < leave
}

/** How many of a line's segments pass through the rects, counting each rect once per segment. */
function passes(line: ReadonlyArray<Point>, rects: ReadonlyArray<Rect>): number {
  let count = 0

  for (let index = 1; index < line.length; index += 1) {
    const p = line[index - 1]
    const q = line[index]

    if (p !== undefined && q !== undefined) {
      count += rects.filter((rect) => segmentHitsRect(p, q, rect)).length
    }
  }

  return count
}

function turn(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/** How many times two sampled curves cross each other. */
export function crossings(a: ReadonlyArray<Point>, b: ReadonlyArray<Point>): number {
  let count = 0

  for (let i = 1; i < a.length; i += 1) {
    const p = a[i - 1]
    const q = a[i]

    for (let j = 1; j < b.length; j += 1) {
      const r = b[j - 1]
      const t = b[j]

      if (p === undefined || q === undefined || r === undefined || t === undefined) {
        continue
      }

      const sides = [turn(r, t, p), turn(r, t, q), turn(p, q, r), turn(p, q, t)] as const

      // Touching counts, since a crossing can land exactly on a sample; lying along each other doesn't.
      if (sides.every((side) => side === 0)) {
        continue
      }

      if (sides[0] * sides[1] <= 0 && sides[2] * sides[3] <= 0) {
        count += 1
      }
    }
  }

  return count
}

const BENDS = [0, 0.12, -0.12, 0.25, -0.25, 0.4, -0.4]
const LABEL_STOPS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.27, 0.73]
/** How much of an edge must show past its label for the label to sit on the line rather than beside it. */
const LINE_SHOWING = 24
/**
 * The rank gap a label needs beyond its own width. It leaves more than LINE_SHOWING, because the gaps at each
 * node don't shrink with the drawing.
 */
const LABEL_CLEARANCE = 48

interface Routable {
  readonly edge: DiagramEdge
  readonly from: Rect
  readonly to: Rect
  readonly shape: EdgeShape
}

/** `auto` runs an edge orthogonally when its ends sit in different rows, and curves it between neighbours in one. */
function shapeFor(
  edge: DiagramEdge,
  from: Rect,
  to: Rect,
  direction: "right" | "down",
  routing: "auto" | EdgeShape,
): EdgeShape {
  if (edge.route !== undefined) {
    return edge.route
  }

  if (routing !== "auto") {
    return routing
  }

  const across = direction === "right" ? 1 : 0
  const offset = Math.abs(rectCenter(from)[across] - rectCenter(to)[across])
  const size = direction === "right" ? Math.min(from.height, to.height) : Math.min(from.width, to.width)
  return offset > size / 4 ? "orthogonal" : "curve"
}

function extent(rect: Rect, axis: 0 | 1): readonly [number, number] {
  return axis === 0 ? [rect.x, rect.x + rect.width] : [rect.y, rect.y + rect.height]
}

const LANE_STEPS = [0, 1, -1, 2, -2]

/**
 * Where the middle run of an elbow between facing sides may cross the gap between them, as a fraction of the way
 * from start to end: down the middle of each stretch of the gap that no other node blocks along the run, or in a
 * lane beside it, so it can pass another elbow in the same channel. `lane` counts lanes from the middle.
 */
function channelMids(
  from: Rect,
  to: Rect,
  ports: readonly [Port, Port],
  obstacles: ReadonlyArray<Rect>,
): ReadonlyArray<{
  readonly mid: number
  readonly lane: number
}> {
  const middle = [
    {
      mid: 0.5,
      lane: 0,
    },
  ]
  const vertical = leavesVertically(ports[0])

  if (vertical !== leavesVertically(ports[1])) {
    return middle
  }

  const a = attach(from, ports[0])
  const b = attach(to, ports[1])
  const axis = vertical ? 1 : 0
  const across = vertical ? 0 : 1
  const low = Math.min(a[axis], b[axis])
  const high = Math.max(a[axis], b[axis])
  const spanLow = Math.min(a[across], b[across])
  const spanHigh = Math.max(a[across], b[across])

  if (high - low < 1) {
    return middle
  }

  const blocked = obstacles
    .filter((rect) => {
      const [start, end] = extent(rect, across)
      return start < spanHigh && end > spanLow
    })
    .map((rect) => extent(rect, axis))
    .sort((x, y) => x[0] - y[0])
  const free: Array<readonly [number, number]> = []
  let cursor = low

  for (const [start, end] of blocked) {
    if (start > cursor) {
      free.push([cursor, Math.min(start, high)])
    }

    cursor = Math.max(cursor, end)
  }

  if (cursor < high) {
    free.push([cursor, high])
  }

  const mids = free.flatMap(([start, end]) =>
    LANE_STEPS.filter((step) => Math.abs(step * LANE) < (end - start) / 2 - 4).map((step) => ({
      mid: ((start + end) / 2 + step * LANE - a[axis]) / (b[axis] - a[axis]),
      lane: Math.abs(step),
    })),
  )
  return mids.length === 0 ? middle : mids
}

function permutations<T>(items: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> {
  if (items.length < 2) {
    return [items]
  }

  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  )
}

/**
 * Elbows whose middle runs would lie on top of each other in one channel move apart into parallel lanes, in the
 * order that crosses least.
 */
function separateLanes(routable: ReadonlyArray<Routable>, routes: ReadonlyArray<EdgeRoute>): ReadonlyArray<EdgeRoute> {
  const runs = routes.flatMap((route, index) => {
    const ends = routable[index]
    const vertical = leavesVertically(route.from)

    if (ends === undefined || route.shape !== "orthogonal" || vertical !== leavesVertically(route.to)) {
      return []
    }

    const a = attach(ends.from, route.from)
    const b = attach(ends.to, route.to)
    const axis = vertical ? 1 : 0
    const across = vertical ? 0 : 1

    if (Math.abs(b[across] - a[across]) < 2 || Math.abs(b[axis] - a[axis]) < 1) {
      return []
    }

    return [
      {
        index,
        vertical,
        start: a[axis],
        end: b[axis],
        at: lerp(a[axis], b[axis], route.mid),
        low: Math.min(a[across], b[across]),
        high: Math.max(a[across], b[across]),
      },
    ]
  })
  type Run = (typeof runs)[number]
  let groups: Run[][] = []

  for (const run of runs) {
    const shares = (other: Run): boolean =>
      other.vertical === run.vertical &&
      Math.abs(other.at - run.at) < LANE &&
      other.low < run.high &&
      run.low < other.high
    const joined = groups.filter((group) => group.some(shares))
    groups = [...groups.filter((group) => !joined.includes(group)), [...joined.flat(), run]]
  }

  const result = [...routes]
  const withMid = (run: Run, lane: number): EdgeRoute | undefined => {
    const route = routes[run.index]
    return route === undefined
      ? undefined
      : {
          ...route,
          mid: (lane - run.start) / (run.end - run.start),
        }
  }
  const lineOf = (run: Run, route: EdgeRoute | undefined): ReadonlyArray<Point> => {
    const ends = routable[run.index]
    return ends === undefined || route === undefined ? [] : polyline(routePath(route, ends.from, ends.to))
  }

  for (const group of groups) {
    if (group.length < 2) {
      continue
    }

    const centre = mean(group.map((run) => run.at)) ?? 0
    const laneOf = (position: number): number => centre + (position - (group.length - 1) / 2) * LANE
    const orders = group.length <= 5 ? permutations(group) : [group]
    let best = {
      crossed: Infinity,
      order: group as ReadonlyArray<Run>,
    }

    for (const order of orders) {
      const lines = order.map((run, position) => lineOf(run, withMid(run, laneOf(position))))
      const crossed = lines.reduce(
        (sum, line, index) => sum + lines.slice(index + 1).reduce((total, other) => total + crossings(line, other), 0),
        0,
      )

      if (crossed < best.crossed) {
        best = {
          crossed,
          order,
        }
      }
    }

    best.order.forEach((run, position) => {
      const route = withMid(run, laneOf(position))

      if (route !== undefined) {
        result[run.index] = route
      }
    })
  }

  return result
}

/**
 * Chooses each edge's sides and shape from a few candidates: the facing sides or a side across the other axis;
 * a curve straight or bowed either way, or an elbow through any clear stretch of the gap. The cheapest wins,
 * counting passes through other nodes most, then crossings with other edges, then length, with a nudge towards
 * the plain route. A second pass reorders the ports by where each edge actually arrives from and chooses again;
 * then elbows sharing a channel move into lanes.
 */
function chooseRoutes(
  routable: ReadonlyArray<Routable>,
  rects: ReadonlyMap<string, Rect>,
  footprints: ReadonlyMap<string, Rect>,
  direction: "right" | "down",
  scale: number,
): ReadonlyArray<EdgeRoute> {
  const edges = routable.map(({ edge }) => edge)
  const primary = routable.map(({ from, to }): SidePair => {
    const side = exitSide(from, to, direction)
    return [side, OPPOSITE[side]]
  })
  const sides = [...primary]
  const bends = routable.map(({ edge, shape }) => (shape === "curve" ? (edge.bend ?? 0) : 0))
  const mids = routable.map(() => 0.5)
  const obstacles = routable.map(({ edge }) =>
    [...footprints].filter(([id]) => id !== edge.from && id !== edge.to).map(([, rect]) => expandRect(rect, 6)),
  )
  const routeOf = (index: number, ports: readonly [Port, Port] | undefined, bend: number, mid: number): EdgeRoute => ({
    shape: routable[index]?.shape ?? "curve",
    from: ports?.[0] ?? CENTRE_PORT,
    to: ports?.[1] ?? CENTRE_PORT,
    bend,
    mid,
    labelT: 0.5,
    labelOffset: [0, 0],
  })
  const pathOf = (index: number, ports: readonly [Port, Port] | undefined, bend: number, mid: number): Path => {
    const { from, to } = routable[index] ?? {}
    return from === undefined || to === undefined ? [] : routePath(routeOf(index, ports, bend, mid), from, to)
  }
  let approach = (index: number, end: 0 | 1): Point => {
    const ends = routable[index]
    return ends === undefined ? [0, 0] : rectCenter(end === 0 ? ends.to : ends.from)
  }

  for (let pass = 0; pass < 2; pass += 1) {
    routable.forEach(({ edge, shape }, index) => {
      const ends = routable[index]
      const plain = primary[index]

      if (ends === undefined || plain === undefined) {
        return
      }

      const options = shape === "curve" && edge.bend !== undefined ? [plain] : sideOptions(ends.from, ends.to, plain)
      let best = {
        cost: Infinity,
        sides: plain,
        bend: bends[index] ?? 0,
        mid: mids[index] ?? 0.5,
      }

      for (const option of options) {
        const trial = sides.map((pair, other) => (other === index ? option : pair))
        const ports = assignPorts(edges, rects, trial, approach, scale)
        const others = routable.map((_, other) =>
          other === index ? [] : polyline(pathOf(other, ports[other], bends[other] ?? 0, mids[other] ?? 0.5)),
        )
        const portPair = ports[index] ?? [CENTRE_PORT, CENTRE_PORT]
        const variants =
          shape === "orthogonal"
            ? channelMids(ends.from, ends.to, portPair, obstacles[index] ?? []).map(({ mid, lane }) => ({
                bend: 0,
                mid,
                lane,
              }))
            : shape === "straight"
              ? [{ bend: 0, mid: 0.5, lane: 0 }]
              : (edge.bend === undefined ? BENDS : [edge.bend]).map((bend) => ({ bend, mid: 0.5, lane: 0 }))

        for (const { bend, mid, lane } of variants) {
          const path = pathOf(index, portPair, bend, mid)
          const line = polyline(path)
          const hits = passes(line, obstacles[index] ?? [])
          const crossed = others.reduce((sum, other) => sum + crossings(line, other), 0)
          const cost =
            hits * 1000 +
            crossed * 200 +
            pathLength(path) * 0.05 +
            (option === plain ? 0 : 15) +
            lane * 2 +
            Math.abs(bend - (shape === "curve" ? (edge.bend ?? 0) : 0)) * 40

          if (cost < best.cost) {
            best = {
              cost,
              sides: option,
              bend,
              mid,
            }
          }
        }
      }

      sides[index] = best.sides
      bends[index] = best.bend
      mids[index] = best.mid
    })

    if (pass === 0) {
      const ports = assignPorts(edges, rects, sides, approach, scale)
      const paths = routable.map((_, index) => pathOf(index, ports[index], bends[index] ?? 0, mids[index] ?? 0.5))
      approach = (index, end) => {
        const path = paths[index]
        return path === undefined ? [0, 0] : pointOnPath(path, end === 0 ? 0.25 : 0.75)
      }
    }
  }

  const ports = assignPorts(edges, rects, sides, approach, scale)
  return separateLanes(
    routable,
    routable.map((_, index) => routeOf(index, ports[index], bends[index] ?? 0, mids[index] ?? 0.5)),
  )
}

/** The stretch of an elbow its label sits on, its longest straight run, as fractions of the way along. */
function labelStretch(route: EdgeRoute, path: Path): readonly [number, number] {
  const lengths = path.map(curveLength)
  const total = lengths.reduce((sum, length) => sum + length, 0)
  let best: readonly [number, number] = [0, 1]
  let longest = 0
  let before = 0

  if (route.shape !== "orthogonal" || total === 0) {
    return best
  }

  path.forEach((curve, index) => {
    const length = lengths[index] ?? 0

    if (isStraight(curve) && length > longest) {
      longest = length
      best = [before / total, (before + length) / total]
    }

    before += length
  })

  return best
}

/** Routes the edges and places their labels. */
function routeEdges(
  edges: ReadonlyArray<DiagramEdge>,
  rects: ReadonlyMap<string, Rect>,
  footprints: ReadonlyMap<string, Rect>,
  noteRects: ReadonlyArray<Rect>,
  direction: "right" | "down",
  routing: "auto" | EdgeShape,
  scale: number,
): Map<string, EdgeRoute> {
  const routable = edges.flatMap((edge) => {
    const from = rects.get(edge.from)
    const to = rects.get(edge.to)

    if (from === undefined || to === undefined || edge.from === edge.to) {
      return []
    }

    return [
      {
        edge,
        from,
        to,
        shape: shapeFor(edge, from, to, direction, routing),
      },
    ]
  })
  const chosen = chooseRoutes(routable, rects, footprints, direction, scale)
  const placed = placeLabels(
    routable.flatMap((entry, index) => {
      const route = chosen[index]
      return route === undefined ? [] : [{ ...entry, route }]
    }),
    footprints,
    noteRects,
    scale,
  )

  return new Map(placed.map((route, index) => [routable[index]?.edge.id ?? "", route]))
}

interface Placing {
  readonly edge: DiagramEdge
  readonly from: Rect
  readonly to: Rect
  readonly route: EdgeRoute
}

/** The label's extent along a direction, given as a unit vector. */
function spanAlong(size: readonly [number, number], [x, y]: Point): number {
  return Math.abs(x) * size[0] + Math.abs(y) * size[1]
}

/**
 * Slides each label along its edge (an elbow's longest run) to the first spot clear of nodes, notes, labels
 * already placed, and other edges, or beside the line when the edge is too short to carry it. Parallel edges
 * between one pair of nodes too close together for their labels to sit between them stack them instead: the
 * outermost edges carry theirs outside the bundle, and the ones in the middle on their lines.
 */
function placeLabels(
  placing: ReadonlyArray<Placing>,
  footprints: ReadonlyMap<string, Rect>,
  noteRects: ReadonlyArray<Rect>,
  scale: number,
): ReadonlyArray<EdgeRoute> {
  const paths = placing.map(({ route, from, to }) => routePath(route, from, to))
  const lines = paths.map(polyline)
  const sizes = placing.map(({ edge }) =>
    edge.label === undefined ? undefined : (labelSize(edge.label).map((value) => value * scale) as [number, number]),
  )
  const pairOf = ({ edge }: Placing): string => [edge.from, edge.to].sort().join("|")
  const labels: Rect[] = []

  return placing.map((entry, index) => {
    const { edge, route } = entry
    const size = sizes[index]
    const path = paths[index] ?? []

    if (size === undefined) {
      return {
        ...route,
        labelT: edge.labelAt ?? 0.5,
      }
    }

    const [start, end] = labelStretch(route, path)
    const length = pathLength(path) * (end - start)
    const blockers = [...footprints.values(), ...noteRects, ...labels]
    const along = LABEL_STOPS.map((stop) => lerp(start, end, stop))
    const stops = edge.labelAt === undefined ? along : [edge.labelAt, ...along]
    const onLine = stops.flatMap((t) => {
      const [dx, dy] = tangentOnPath(path, t)
      const covered = Math.abs(dx) * size[0] + Math.abs(dy) * size[1]
      return length - covered >= LINE_SHOWING * scale ? [{ t, offset: [0, 0] as Point }] : []
    })
    const beside = stops.flatMap((t) => {
      const [dx, dy] = tangentOnPath(path, t)
      const away = (Math.abs(dy) * size[0]) / 2 + (Math.abs(dx) * size[1]) / 2 + 6 * scale
      return [1, -1].map((sign) => ({ t, offset: [-dy * away * sign, dx * away * sign] as Point }))
    })
    // Twice as far out, past a label already beside a neighbouring edge.
    const further = beside.map(({ t, offset }) => ({ t, offset: [offset[0] * 2, offset[1] * 2] as Point }))

    const middle = pointOnPath(path, 0.5)
    const [tx, ty] = tangentOnPath(path, 0.5)
    const normal: Point = [-ty, tx]
    const bundle = placing.flatMap((other, position) => {
      if (position === index || pairOf(other) !== pairOf(entry)) {
        return []
      }

      const [x, y] = pointOnPath(paths[position] ?? [], 0.5)
      const otherSize = sizes[position]
      return [
        {
          across: (x - middle[0]) * normal[0] + (y - middle[1]) * normal[1],
          room: (spanAlong(size, normal) + (otherSize === undefined ? 0 : spanAlong(otherSize, normal))) / 2,
        },
      ]
    })
    const between = bundle.every(({ across, room }) => Math.abs(across) >= room + LABEL_PAD * scale)
    const outward = bundle.every(({ across }) => across > 0) ? -1 : bundle.every(({ across }) => across < 0) ? 1 : 0
    const stacked =
      between || outward === 0
        ? []
        : beside.filter(({ offset }) => (offset[0] * normal[0] + offset[1] * normal[1]) * outward > 0)
    const candidates = [...stacked, ...onLine, ...beside, ...further]
    const rectAt = ({ t, offset }: { readonly t: number; readonly offset: Point }): Rect =>
      centeredRect(addPoints(pointOnPath(path, t), offset), size)
    // A label covering another edge hides where it goes, so that costs as much as a large overlap.
    const otherLines = lines.filter((_, other) => other !== index)
    const score = (candidate: { readonly t: number; readonly offset: Point }): number =>
      blockers.reduce((sum, rect) => sum + overlapArea(rect, rectAt(candidate)), 0) +
      otherLines.reduce((sum, line) => sum + passes(line, [rectAt(candidate)]), 0) * 400
    const best =
      candidates.find((candidate) => score(candidate) === 0) ??
      candidates.reduce((a, b) => (score(b) < score(a) ? b : a))

    labels.push(rectAt(best))
    return {
      ...route,
      labelT: best.t,
      labelOffset: best.offset,
    }
  })
}

/**
 * Keeps every node at its position and routes edges as auto layout does. Group boxes cover all their nodes, shown
 * or not, so they don't change between stages.
 */
function manualLayout(request: LayoutRequest, everyNode: ReadonlyArray<DiagramNode>): StageLayout {
  const position = (id: string): Point => request.pins.get(id) ?? [0, 0]
  const centres = new Map(request.nodes.map((node) => [node.id, position(node.id)]))
  const rectsOf = (nodes: ReadonlyArray<DiagramNode>, measure: typeof nodeRect): Map<string, Rect> =>
    new Map(
      nodes.flatMap((node) => {
        const view = request.views.get(node.id)
        return view === undefined ? [] : [[node.id, measure(view, position(node.id), 1)] as const]
      }),
    )
  const rects = rectsOf(request.nodes, nodeRect)
  const footprints = rectsOf(request.nodes, footprint)
  const allFootprints = rectsOf(everyNode, footprint)

  const notes = new Map(
    request.notes.flatMap((note) => {
      const pinned = request.pins.get(note.id)
      return pinned === undefined ? [] : [[note.id, pinned] as const]
    }),
  )

  for (const [id, centre] of placeNotes(
    request.notes.filter((note) => !notes.has(note.id)),
    footprints,
    1,
  )) {
    notes.set(id, centre)
  }

  const groups = groupBoxes(request.groups, (group) => group.contains.flatMap((id) => allFootprints.get(id) ?? []), 1)
  const noteRects = request.notes.flatMap((note) => {
    const centre = notes.get(note.id)
    return centre === undefined ? [] : [centeredRect(centre, note.size)]
  })

  return {
    scale: 1,
    nodes: centres,
    notes,
    groups,
    edges: routeEdges(request.edges, rects, footprints, noteRects, request.direction, request.routing, 1),
  }
}

/**
 * Turns ranks and half rows into unscaled centres: ranks as wide as their widest node, gaps wide enough for the
 * labels between them and widened when there is room, rows as tall as the tallest node plus a gap.
 */
function gridCentres(
  request: LayoutRequest,
  graph: RankedGraph,
  layers: ReadonlyArray<ReadonlyArray<string>>,
  rows: ReadonlyMap<string, number>,
  internal: ReadonlyArray<DiagramEdge>,
): Map<string, Point> {
  const { canvas, direction, views } = request
  const { nodes, ranks } = graph
  const view = (id: string): NodeView | undefined => views.get(id)

  const mainSize = (id: string): number => {
    const v = view(id)
    const stack = stackOffset(v?.replicas)
    return direction === "right" ? (v?.size[0] ?? 0) + stack : (v?.size[1] ?? 0) + stack
  }
  const crossSize = (id: string): number => {
    const v = view(id)
    const stack = stackOffset(v?.replicas)
    return direction === "right" ? (v?.size[1] ?? 0) + stack : (v?.size[0] ?? 0) + stack
  }
  const labelSpan = (label: string): number => {
    const [width, height] = labelSize(label)
    return direction === "right" ? width : height
  }

  const columns = layers.map((layer) => Math.max(0, ...layer.map(mainSize)))
  const gaps = columns.slice(1).map(() => MIN_RANK_GAP)
  let sameRankLabel = 0

  for (const edge of internal) {
    const a = ranks.get(edge.from) ?? 0
    const b = ranks.get(edge.to) ?? 0

    if (edge.label === undefined) {
      continue
    }

    if (a === b) {
      const [width, height] = labelSize(edge.label)
      sameRankLabel = Math.max(sameRankLabel, direction === "right" ? height : width)
      continue
    }

    // Labels of longer edges slide along them to a gap that has room.
    if (Math.abs(a - b) === 1) {
      const gap = Math.min(a, b)
      gaps[gap] = Math.max(gaps[gap] ?? 0, labelSpan(edge.label) + LABEL_CLEARANCE)
    }
  }

  const crossGap = Math.max(CROSS_GAP, sameRankLabel + 16)
  const halfRow = (Math.max(0, ...nodes.map((node) => crossSize(node.id))) + crossGap) / 2
  const crossValues = [...rows.values()]
  const crossExtent =
    crossValues.length === 0
      ? 0
      : (Math.max(...crossValues) - Math.min(...crossValues)) * halfRow +
        Math.max(0, ...nodes.map((node) => crossSize(node.id)))
  const availableMain = (direction === "right" ? canvas.width : canvas.height) - MARGIN * 2
  const availableCross = (direction === "right" ? canvas.height : canvas.width) - MARGIN * 2
  const crossFit = crossExtent === 0 ? 1 : Math.min(1, availableCross / crossExtent)
  const natural = columns.reduce((sum, value) => sum + value, 0) + gaps.reduce((sum, value) => sum + value, 0)

  // Spare room widens the rank gaps, up to a point, so a small stage spreads across the canvas.
  if (gaps.length > 0 && natural < availableMain / crossFit) {
    const extra = (availableMain / crossFit - natural) / gaps.length

    gaps.forEach((gap, index) => {
      gaps[index] = Math.max(gap, Math.min(gap + extra, MAX_RANK_GAP))
    })
  }

  const mainPositions: number[] = []
  let cursor = 0

  columns.forEach((width, index) => {
    mainPositions.push(cursor + width / 2)
    cursor += width + (gaps[index] ?? 0)
  })

  return new Map(
    nodes.map((node) => {
      const main = mainPositions[ranks.get(node.id) ?? 0] ?? 0
      const across = (rows.get(node.id) ?? 0) * halfRow
      return [node.id, (direction === "right" ? [main, across] : [across, main]) as Point]
    }),
  )
}

/**
 * Lays out one stage. `manual` puts every node at its `at`. `auto` ranks the free nodes along `direction`,
 * orders and aligns them on a grid, spreads the ranks to leave room for edge labels, then centres the whole
 * drawing and scales it down if it would not fit; pinned nodes and notes keep their canvas positions.
 */
export function layoutStage(request: LayoutRequest, everyNode: ReadonlyArray<DiagramNode>): StageLayout {
  if (request.mode === "manual") {
    return manualLayout(request, everyNode)
  }

  const { canvas, direction, views } = request
  const view = (id: string): NodeView | undefined => views.get(id)
  const free = request.nodes.filter((node) => !request.pins.has(node.id))
  const freeIds = new Set(free.map((node) => node.id))
  const internal = request.edges.filter((edge) => freeIds.has(edge.from) && freeIds.has(edge.to))
  const previousCross = new Map(
    [...(request.previous?.nodes ?? [])].map(([id, point]) => [id, cross(point, direction)]),
  )
  const ranks = assignRanks(free, internal)
  const graph = rankedGraph(free, ranks, internal, request.groups)
  const layers = orderRanks(graph, previousCross)
  const rows = placeRows(graph, layers, direction)

  const natCentres = gridCentres(request, graph, layers, rows, internal)
  const natFootprints = new Map(
    free.flatMap((node) => {
      const v = view(node.id)
      const centre = natCentres.get(node.id)
      return v === undefined || centre === undefined ? [] : [[node.id, footprint(v, centre, 1)] as const]
    }),
  )
  const freeNotes = request.notes.filter((note) => !request.pins.has(note.id))
  const natNotes = placeNotes(freeNotes, natFootprints, 1)
  // A note beside a member belongs inside the group's box.
  const memberNotes = (group: DiagramGroup, centres: ReadonlyMap<string, Point>, scale: number): Rect[] =>
    request.notes.flatMap((note) => {
      const centre = centres.get(note.id)
      const inside = note.near !== undefined && group.contains.includes(note.near)
      return inside && centre !== undefined ? [centeredRect(centre, [note.size[0] * scale, note.size[1] * scale])] : []
    })
  const natGroups = groupBoxes(
    request.groups,
    (group) => [...group.contains.flatMap((id) => natFootprints.get(id) ?? []), ...memberNotes(group, natNotes, 1)],
    1,
  ).values()
  const box = boundingRect([
    ...natFootprints.values(),
    ...natGroups,
    ...freeNotes.flatMap((note) => {
      const centre = natNotes.get(note.id)
      return centre === undefined ? [] : [centeredRect(centre, note.size)]
    }),
  ])

  const scale =
    box === undefined
      ? 1
      : Math.min(1, (canvas.width - MARGIN * 2) / box.width, (canvas.height - MARGIN * 2) / box.height)
  const boxCentre = box === undefined ? ([0, 0] as Point) : rectCenter(box)
  const toCanvas = ([x, y]: Point): Point => [
    canvas.width / 2 + (x - boxCentre[0]) * scale,
    canvas.height / 2 + (y - boxCentre[1]) * scale,
  ]

  const centres = new Map<string, Point>()

  for (const node of request.nodes) {
    const pinned = request.pins.get(node.id)
    const centre = pinned ?? natCentres.get(node.id)

    if (centre !== undefined) {
      centres.set(node.id, pinned ?? toCanvas(centre))
    }
  }

  const rects = new Map<string, Rect>()
  const footprints = new Map<string, Rect>()

  for (const [id, centre] of centres) {
    const v = view(id)

    if (v !== undefined) {
      rects.set(id, nodeRect(v, centre, scale))
      footprints.set(id, footprint(v, centre, scale))
    }
  }

  const notes = new Map<string, Point>()

  for (const note of request.notes) {
    const natural = natNotes.get(note.id)
    const centre = request.pins.get(note.id) ?? (natural === undefined ? undefined : toCanvas(natural))

    if (centre !== undefined) {
      notes.set(note.id, centre)
    }
  }

  // Notes beside a pinned node are placed after the pins are known.
  for (const [id, centre] of placeNotes(
    request.notes.filter((note) => !notes.has(note.id)),
    footprints,
    scale,
  )) {
    notes.set(id, centre)
  }

  const groups = groupBoxes(
    request.groups,
    (group) => [...group.contains.flatMap((id) => footprints.get(id) ?? []), ...memberNotes(group, notes, scale)],
    scale,
  )
  const noteRects = request.notes.flatMap((note) => {
    const centre = notes.get(note.id)
    return centre === undefined ? [] : [centeredRect(centre, [note.size[0] * scale, note.size[1] * scale])]
  })

  return {
    scale,
    nodes: centres,
    notes,
    groups,
    edges: routeEdges(request.edges, rects, footprints, noteRects, direction, request.routing, scale),
  }
}
