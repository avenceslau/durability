import type { Point } from "./geometry.ts"

export interface SnapItem {
  readonly id: string
  readonly point: Point
  /** Width and height, to check that snapping doesn't push boxes into each other. */
  readonly size: readonly [number, number]
  /** Nodes anchor a row or column; notes snap to them without pulling them. */
  readonly anchor: boolean
}

/** Consecutive gaps within this ratio of each other are evened out. */
const EVEN_RATIO = 1.25

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** Spaces the centres of each run of nearly equal gaps evenly between the run's two ends. */
function evenOut(centres: number[]): void {
  const gaps = centres.slice(1).map((centre, index) => centre - (centres[index] ?? 0))
  let start = 0

  while (start < gaps.length) {
    let end = start

    while (end + 1 < gaps.length) {
      const run = gaps.slice(start, end + 2)

      if (Math.max(...run) > Math.min(...run) * EVEN_RATIO) {
        break
      }

      end += 1
    }

    const first = centres[start] ?? 0
    const last = centres[end + 1] ?? 0
    const count = end + 1 - start

    for (let index = start + 1; index <= end; index += 1) {
      centres[index] = first + ((last - first) * (index - start)) / count
    }

    start = end + 1
  }
}

/**
 * Snaps one axis: coordinates within `tolerance` of the first in their cluster share the median of the anchors
 * among them, then the clusters' spacing is evened out where it is nearly even already.
 */
function snapAxis(items: ReadonlyArray<SnapItem>, axis: 0 | 1, tolerance: number): ReadonlyArray<number> {
  const order = items.map((_, index) => index).sort((a, b) => (items[a]?.point[axis] ?? 0) - (items[b]?.point[axis] ?? 0))
  const clusters: number[][] = []

  for (const index of order) {
    const value = items[index]?.point[axis] ?? 0
    const current = clusters[clusters.length - 1]
    const start = current === undefined ? undefined : items[current[0] ?? 0]?.point[axis]

    if (current === undefined || start === undefined || value - start > tolerance) {
      clusters.push([index])
    } else {
      current.push(index)
    }
  }

  const centres = clusters.map((members) => {
    const anchors = members.filter((index) => items[index]?.anchor)
    return median((anchors.length > 0 ? anchors : members).map((index) => items[index]?.point[axis] ?? 0))
  })
  evenOut(centres)

  const snapped = items.map((item) => item.point[axis])
  clusters.forEach((members, cluster) => {
    for (const index of members) {
      snapped[index] = centres[cluster] ?? snapped[index] ?? 0
    }
  })

  return snapped
}

function overlap(a: Point, aSize: readonly [number, number], b: Point, bSize: readonly [number, number]): boolean {
  return (
    Math.abs(a[0] - b[0]) * 2 < aSize[0] + bSize[0] &&
    Math.abs(a[1] - b[1]) * 2 < aSize[1] + bSize[1]
  )
}

/**
 * Lines hand-placed positions up: x and y coordinates within `tolerance` of each other snap to shared columns and
 * rows, and nearly even gaps between them become even. Where snapping would push two items into each other, one
 * of them goes back to where it was drawn.
 */
export function snapPositions(items: ReadonlyArray<SnapItem>, tolerance: number): ReadonlyMap<string, Point> {
  const xs = snapAxis(items, 0, tolerance)
  const ys = snapAxis(items, 1, tolerance)
  const positions = items.map((item, index): Point => [xs[index] ?? item.point[0], ys[index] ?? item.point[1]])

  for (let pass = 0; pass < items.length; pass += 1) {
    let reverted = false

    items.forEach((a, i) => {
      items.forEach((b, j) => {
        const pa = positions[i]
        const pb = positions[j]

        if (j <= i || pa === undefined || pb === undefined) {
          return
        }

        if (!overlap(pa, a.size, pb, b.size) || overlap(a.point, a.size, b.point, b.size)) {
          return
        }

        // Undo the smaller loss: a note before a node, otherwise whichever moved further.
        const moved = (point: Point, item: SnapItem): number =>
          (item.anchor ? 0 : 1e6) + Math.hypot(point[0] - item.point[0], point[1] - item.point[1])

        if (moved(pa, a) >= moved(pb, b)) {
          positions[i] = a.point
        } else {
          positions[j] = b.point
        }

        reverted = true
      })
    })

    if (!reverted) {
      break
    }
  }

  return new Map(items.map((item, index) => [item.id, positions[index] ?? item.point]))
}
