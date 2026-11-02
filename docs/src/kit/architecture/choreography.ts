import { lerp, lerpPoint, type Point, type Rect, rectCenter } from "./geometry.ts"
import { type EdgeRoute, NODE, type Port, type StageLayout } from "./layout.ts"
import type { ArchitectureDiagram, NodeView } from "./model.ts"

/** Phase lengths in milliseconds: nodes move, then new ones appear, then new edges draw in. */
export interface Timing {
  readonly move: number
  readonly appear: number
  readonly draw: number
}

export const DEFAULT_TIMING: Timing = {
  move: 500,
  appear: 300,
  draw: 450,
}

export type Phase = "retract" | "disappear" | "move" | "appear" | "draw"

/** The parts of a stage a transition compares: a `StageState` is one. */
export interface Scene {
  readonly visible: ReadonlySet<string>
  readonly nodes: ReadonlyMap<string, NodeView>
  readonly ends: ReadonlyMap<string, readonly [string, string]>
  readonly layout: StageLayout
}

export interface PhaseWindow {
  readonly start: number
  readonly duration: number
}

/** Which elements do what between two scenes, matched by id, and when each phase runs. */
export interface TransitionPlan {
  /** Edges shown before and not after: they draw back to their start first. */
  readonly retract: ReadonlyArray<string>
  /** Nodes, notes, and groups that leave without a replacement: they fade out next. */
  readonly disappear: ReadonlyArray<string>
  /** Nodes, notes, and groups shown in both whose position or size changes, and edges shown in both whose route does. */
  readonly move: ReadonlyArray<string>
  /** Nodes shown in both whose label, sublabel, icon, tone, or replicas change: they crossfade while moving. */
  readonly change: ReadonlyArray<string>
  /** A leaving node and an arriving one joined by `replaces`: one grows out of, or shrinks into, the other. */
  readonly morph: ReadonlyArray<{
    readonly from: string
    readonly to: string
  }>
  /** Nodes, notes, and groups that arrive without a predecessor: they fade and grow in after the moves. */
  readonly appear: ReadonlyArray<string>
  /**
   * Composites opening: after the moves, the box turns into the group's outline as the nodes inside grow out of
   * it. Their edges move over to those nodes as they start to grow.
   */
  readonly expand: ReadonlyArray<string>
  /** Composites closing: before the moves, the nodes inside shrink into the box as the outline closes round them. */
  readonly collapse: ReadonlyArray<string>
  /** The nodes growing out of each opening composite, or shrinking into each closing one, with that composite. */
  readonly members: ReadonlyMap<string, string>
  /** Edges shown after and not before: they draw in last, then show their labels. */
  readonly draw: ReadonlyArray<string>
  /** Edges shown in both, which follow their nodes. */
  readonly keep: ReadonlyArray<string>
  readonly windows: Readonly<Record<Phase, PhaseWindow>>
  /** Stagger within the appear and draw phases, earlier ranks first. */
  readonly delays: ReadonlyMap<string, number>
  readonly timing: Timing
  readonly duration: number
}

export interface NodeFrame {
  readonly center: Point
  /** Unscaled width and height. */
  readonly size: readonly [number, number]
  readonly scale: number
  readonly opacity: number
  readonly view: NodeView
  /** What the node showed before a change in place, fading out under `view`. */
  readonly previous: NodeView | undefined
  /** How far the change has gone, from 0 (all `previous`) to 1. */
  readonly mix: number
}

export interface NoteFrame {
  readonly center: Point
  readonly scale: number
  readonly opacity: number
}

export interface GroupFrame {
  readonly rect: Rect
  readonly scale: number
  readonly opacity: number
}

export interface EdgeFrame {
  /** The nodes the edge joins in this frame. */
  readonly from: string
  readonly to: string
  readonly route: EdgeRoute
  /** How much of the line is drawn, from its start. */
  readonly draw: number
  readonly label: number
}

/** Everything the renderer draws at one moment; a settled stage is one, and so is every frame in between. */
export interface Frame {
  readonly scale: number
  readonly nodes: ReadonlyMap<string, NodeFrame>
  readonly notes: ReadonlyMap<string, NoteFrame>
  readonly groups: ReadonlyMap<string, GroupFrame>
  readonly edges: ReadonlyMap<string, EdgeFrame>
}

type Diagram = Pick<ArchitectureDiagram, "canvas" | "nodes" | "edges" | "notes" | "groups">

const STAGGER = 70
const HIDDEN_PORT: Port = {
  u: 0,
  v: 0,
  nx: 0,
  ny: 0,
}

const HIDDEN_ROUTE: EdgeRoute = {
  shape: "curve",
  from: HIDDEN_PORT,
  to: HIDDEN_PORT,
  bend: 0,
  mid: 0.5,
  labelT: 0.5,
  labelOffset: [0, 0],
}

function sameContent(a: NodeView, b: NodeView): boolean {
  return (
    a.label === b.label &&
    a.sublabel === b.sublabel &&
    a.icon === b.icon &&
    a.tone === b.tone &&
    (a.replicas ?? 1) === (b.replicas ?? 1)
  )
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.5
}

function samePoint(a: Point | undefined, b: Point | undefined): boolean {
  return a !== undefined && b !== undefined && near(a[0], b[0]) && near(a[1], b[1])
}

function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    near(a.x, b.x) &&
    near(a.y, b.y) &&
    near(a.width, b.width) &&
    near(a.height, b.height)
  )
}

function samePort(a: Port, b: Port): boolean {
  return [a.u - b.u, a.v - b.v, a.nx - b.nx, a.ny - b.ny].every((difference) => Math.abs(difference) < 1e-6)
}

function sameRoute(a: EdgeRoute | undefined, b: EdgeRoute | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.shape === b.shape &&
    samePort(a.from, b.from) &&
    samePort(a.to, b.to) &&
    Math.abs(a.bend - b.bend) < 1e-6 &&
    Math.abs(a.mid - b.mid) < 1e-6 &&
    Math.abs(a.labelT - b.labelT) < 1e-6 &&
    samePoint(a.labelOffset, b.labelOffset)
  )
}

function isShown(scene: Scene, id: string): boolean {
  const { layout } = scene
  return scene.visible.has(id) && (layout.nodes.has(id) || layout.notes.has(id) || layout.groups.has(id))
}

/** Delays by column: elements whose position along the x axis rounds the same start together. */
function stagger(ids: ReadonlyArray<string>, at: (id: string) => number | undefined, spread: number): Map<string, number> {
  const columns = [...new Set(ids.map((id) => Math.round((at(id) ?? 0) / 40)))].sort((a, b) => a - b)
  const step = columns.length < 2 ? 0 : Math.min(STAGGER, spread / (columns.length - 1))

  return new Map(ids.map((id) => [id, columns.indexOf(Math.round((at(id) ?? 0) / 40)) * step]))
}

/**
 * Plans the transition from one scene to another by element id. A pure function of its inputs, so it works
 * between any two states, forwards or backwards: going back from B to A is `planTransition(diagram, B, A)`.
 */
export function planTransition(
  diagram: Diagram,
  from: Scene,
  to: Scene,
  timing: Timing = DEFAULT_TIMING,
): TransitionPlan {
  const asBox = (scene: Scene, id: string): boolean => scene.visible.has(id) && scene.layout.nodes.has(id)
  const asGroup = (scene: Scene, id: string): boolean => scene.visible.has(id) && scene.layout.groups.has(id)
  const composites = diagram.nodes.filter((node) => node.contains.length > 0)
  const expand = composites.filter(({ id }) => asBox(from, id) && asGroup(to, id)).map(({ id }) => id)
  const collapse = composites.filter(({ id }) => asGroup(from, id) && asBox(to, id)).map(({ id }) => id)
  const contents = (id: string): ReadonlyArray<string> =>
    diagram.nodes.find((node) => node.id === id)?.contains.flatMap((child) => [child, ...contents(child)]) ?? []
  const members = new Map(
    [...expand, ...collapse].flatMap((id) =>
      contents(id)
        .filter((child) => (expand.includes(id) ? asBox(to, child) : asBox(from, child)))
        .map((child) => [child, id] as const),
    ),
  )
  const opening = new Set([...expand, ...collapse, ...members.keys()])
  const nodeIds = new Set(diagram.nodes.map((node) => node.id))
  // A composite's id names both its box and its group.
  const items = [
    ...new Set([
      ...diagram.nodes.map((node) => node.id),
      ...diagram.notes.map((note) => note.id),
      ...diagram.groups.map((group) => group.id),
    ]),
  ].filter((id) => !opening.has(id))
  const leaving = items.filter((id) => isShown(from, id) && !isShown(to, id))
  const arriving = items.filter((id) => !isShown(from, id) && isShown(to, id))
  const staying = items.filter((id) => isShown(from, id) && isShown(to, id))

  const morph = diagram.nodes.flatMap((node) =>
    node.replaces.flatMap((other) => {
      if (leaving.includes(other) && arriving.includes(node.id)) {
        return [{ from: other, to: node.id }]
      }

      if (leaving.includes(node.id) && arriving.includes(other)) {
        return [{ from: node.id, to: other }]
      }

      return []
    }),
  )
  const morphing = new Set(morph.flatMap((pair) => [pair.from, pair.to]))

  const move = staying.filter((id) => {
    if (!to.layout.nodes.has(id)) {
      const noteMoved = to.layout.notes.has(id) && !samePoint(from.layout.notes.get(id), to.layout.notes.get(id))
      const groupMoved = to.layout.groups.has(id) && !sameRect(from.layout.groups.get(id), to.layout.groups.get(id))
      return noteMoved || groupMoved
    }

    const a = from.nodes.get(id)
    const b = to.nodes.get(id)
    return (
      !samePoint(from.layout.nodes.get(id), to.layout.nodes.get(id)) ||
      !near(from.layout.scale, to.layout.scale) ||
      a === undefined ||
      b === undefined ||
      !near(a.size[0], b.size[0]) ||
      !near(a.size[1], b.size[1])
    )
  })
  const change = staying.filter((id) => {
    const a = from.nodes.get(id)
    const b = to.nodes.get(id)
    return nodeIds.has(id) && a !== undefined && b !== undefined && !sameContent(a, b)
  })
  const disappear = leaving.filter((id) => !morphing.has(id))
  const appear = arriving.filter((id) => !morphing.has(id))
  const edgeIds = diagram.edges.map((edge) => edge.id)
  const retract = edgeIds.filter((id) => from.visible.has(id) && !to.visible.has(id))
  const draw = edgeIds.filter((id) => !from.visible.has(id) && to.visible.has(id))
  const keep = edgeIds.filter((id) => from.visible.has(id) && to.visible.has(id))
  const reroute = keep.filter((id) => !sameRoute(from.layout.edges.get(id), to.layout.edges.get(id)))

  const xOf = (id: string): number | undefined =>
    to.layout.nodes.get(id)?.[0] ?? to.layout.notes.get(id)?.[0] ?? to.layout.groups.get(id)?.x
  const edgeFrom = new Map(diagram.edges.map((edge) => [edge.id, edge.from]))
  const appearDelays = stagger(appear, xOf, timing.appear)
  const drawDelays = stagger(draw, (id) => xOf(edgeFrom.get(id) ?? ""), timing.draw)
  const longest = (delays: ReadonlyMap<string, number>): number => Math.max(0, ...delays.values())

  const durations: Record<Phase, number> = {
    retract: retract.length > 0 ? timing.draw * 0.6 : 0,
    disappear: disappear.length > 0 || collapse.length > 0 ? timing.appear : 0,
    move:
      move.length > 0 ||
      reroute.length > 0 ||
      change.length > 0 ||
      morph.length > 0 ||
      !near(from.layout.scale, to.layout.scale)
        ? timing.move
        : 0,
    appear: appear.length > 0 || expand.length > 0 ? timing.appear + longest(appearDelays) : 0,
    draw: draw.length > 0 ? timing.draw + longest(drawDelays) : 0,
  }
  const phases: ReadonlyArray<Phase> = ["retract", "disappear", "move", "appear", "draw"]
  const windows = {} as Record<Phase, PhaseWindow>
  let cursor = 0

  for (const phase of phases) {
    windows[phase] = {
      start: cursor,
      duration: durations[phase],
    }
    cursor += durations[phase]
  }

  return {
    retract,
    disappear,
    move: [...move, ...reroute],
    change,
    morph,
    appear,
    expand,
    collapse,
    members,
    draw,
    keep,
    windows,
    delays: new Map([...appearDelays, ...drawDelays]),
    timing,
    duration: cursor,
  }
}

function hiddenNode(diagram: Diagram, view: NodeView): NodeFrame {
  return {
    center: [diagram.canvas.width / 2, diagram.canvas.height / 2],
    size: view.size,
    scale: 1,
    opacity: 0,
    view,
    previous: undefined,
    mix: 1,
  }
}

/** A settled stage as a frame: shown elements at full strength, hidden ones transparent. */
export function frameOf(diagram: Diagram, scene: Scene): Frame {
  const { layout } = scene
  const nodes = new Map<string, NodeFrame>()

  for (const node of diagram.nodes) {
    const view = scene.nodes.get(node.id)
    const center = layout.nodes.get(node.id)

    if (view === undefined) {
      continue
    }

    nodes.set(
      node.id,
      center === undefined || !scene.visible.has(node.id)
        ? hiddenNode(diagram, view)
        : {
            center,
            size: view.size,
            scale: layout.scale,
            opacity: 1,
            view,
            previous: undefined,
            mix: 1,
          },
    )
  }

  return {
    scale: layout.scale,
    nodes,
    notes: new Map(
      diagram.notes.map((note) => {
        const center = layout.notes.get(note.id)
        const shown = center !== undefined && scene.visible.has(note.id)
        return [
          note.id,
          {
            center: center ?? [0, 0],
            scale: layout.scale,
            opacity: shown ? 1 : 0,
          },
        ]
      }),
    ),
    groups: new Map(
      diagram.groups.map((group) => {
        const rect = layout.groups.get(group.id)
        const shown = rect !== undefined && scene.visible.has(group.id)
        return [
          group.id,
          {
            rect: rect ?? {
              x: 0,
              y: 0,
              width: 0,
              height: 0,
              radius: 0,
            },
            scale: layout.scale,
            opacity: shown ? 1 : 0,
          },
        ]
      }),
    ),
    edges: new Map(
      diagram.edges.map((edge) => {
        const route = layout.edges.get(edge.id)
        const shown = route !== undefined && scene.visible.has(edge.id)
        const [from, to] = scene.ends.get(edge.id) ?? [edge.from, edge.to]
        return [
          edge.id,
          {
            from,
            to,
            route: route ?? HIDDEN_ROUTE,
            draw: shown ? 1 : 0,
            label: shown ? 1 : 0,
          },
        ]
      }),
    ),
  }
}

/** The content a node frame mostly shows, mid-crossfade or not. */
function shownView(frame: NodeFrame): NodeView {
  return frame.previous !== undefined && frame.mix < 0.5 ? frame.previous : frame.view
}

/**
 * The scene a frame mostly shows, so an interrupted transition can be planned onward from where it stopped:
 * elements more than half faded in or drawn count as shown.
 */
export function sceneOfFrame(frame: Frame): Scene {
  const visible = new Set<string>()
  const nodes = new Map<string, NodeView>()
  const centres = new Map<string, Point>()

  for (const [id, node] of frame.nodes) {
    nodes.set(id, {
      ...shownView(node),
      size: node.size,
    })

    if (node.opacity > 0.5) {
      visible.add(id)
      centres.set(id, node.center)
    }
  }

  const shown = <T extends { readonly opacity: number }>(map: ReadonlyMap<string, T>): Array<[string, T]> =>
    [...map].filter(([, item]) => item.opacity > 0.5)

  for (const [id] of [...shown(frame.notes), ...shown(frame.groups)]) {
    visible.add(id)
  }

  const edges = [...frame.edges].filter(([, edge]) => edge.draw > 0.5)

  for (const [id] of edges) {
    visible.add(id)
  }

  return {
    visible,
    nodes,
    ends: new Map(edges.map(([id, edge]) => [id, [edge.from, edge.to] as const])),
    layout: {
      scale: frame.scale,
      nodes: centres,
      notes: new Map(shown(frame.notes).map(([id, note]) => [id, note.center])),
      groups: new Map(shown(frame.groups).map(([id, group]) => [id, group.rect])),
      edges: new Map(edges.map(([id, edge]) => [id, edge.route])),
    },
  }
}

function clamp(value: number): number {
  return Math.min(Math.max(value, 0), 1)
}

function easeInOut(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
}

function progress(start: number, duration: number, t: number): number {
  if (duration <= 0) {
    return t >= start ? 1 : 0
  }

  return easeInOut(clamp((t - start) / duration))
}

/** A morph hands over in the middle: the leaving node is mostly gone before the arriving one is mostly there. */
function morphOut(move: number): number {
  return clamp(move / 0.65)
}

function morphIn(move: number): number {
  return clamp((move - 0.35) / 0.65)
}

function lerpSize(a: readonly [number, number], b: readonly [number, number], t: number): readonly [number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t),
    radius: lerp(a.radius, b.radius, t),
  }
}

function lerpPort(a: Port, b: Port, t: number): Port {
  return {
    u: lerp(a.u, b.u, t),
    v: lerp(a.v, b.v, t),
    nx: lerp(a.nx, b.nx, t),
    ny: lerp(a.ny, b.ny, t),
  }
}

/**
 * Routes blend port by port, so an edge stays attached to both nodes while they move and its sides change. A
 * change of shape, between a curve and an elbow, happens halfway.
 */
export function lerpRoute(a: EdgeRoute, b: EdgeRoute, t: number): EdgeRoute {
  if (t >= 1) {
    return b
  }

  return {
    shape: t < 0.5 ? a.shape : b.shape,
    from: lerpPort(a.from, b.from, t),
    to: lerpPort(a.to, b.to, t),
    bend: lerp(a.bend, b.bend, t),
    mid: lerp(a.mid, b.mid, t),
    labelT: lerp(a.labelT, b.labelT, t),
    labelOffset: lerpPoint(a.labelOffset, b.labelOffset, t),
  }
}

/**
 * The frame `t` milliseconds into a transition from `start` to `target`. Every value runs from what `start`
 * shows, so a transition that begins mid-way through another continues smoothly from where it was.
 */
export function frameAt(start: Frame, target: Scene, plan: TransitionPlan, t: number): Frame {
  const { windows, timing } = plan
  const { layout } = target
  const move = progress(windows.move.start, windows.move.duration, t)
  const disappear = progress(windows.disappear.start, windows.disappear.duration, t)
  const retract = progress(windows.retract.start, windows.retract.duration, t)
  const delay = (id: string): number => plan.delays.get(id) ?? 0
  const appearOf = (id: string): number => progress(windows.appear.start + delay(id), timing.appear, t)
  const appearing = new Set(plan.appear)
  const drawing = new Set(plan.draw)
  const morphFrom = (id: string): ReadonlyArray<string> => plan.morph.filter((pair) => pair.to === id).map((pair) => pair.from)
  const morphTo = (id: string): ReadonlyArray<string> => plan.morph.filter((pair) => pair.from === id).map((pair) => pair.to)

  const unfold = progress(windows.appear.start, timing.appear, t)
  const boxAt = (center: Point, size: readonly [number, number], scale: number): Rect => ({
    x: center[0] - (size[0] * scale) / 2,
    y: center[1] - (size[1] * scale) / 2,
    width: size[0] * scale,
    height: size[1] * scale,
    radius: NODE.radius * scale,
  })
  // Where an opening composite's box ends its move, and where a closing one's group starts.
  const openAt = (id: string): Point => rectCenter(layout.groups.get(id) ?? boxAt([0, 0], [0, 0], 1))
  const closeFrom = (id: string): GroupFrame | undefined => start.groups.get(id)
  const boxSize = (id: string): readonly [number, number] =>
    start.nodes.get(id)?.size ?? target.nodes.get(id)?.size ?? [0, 0]

  const nodes = new Map<string, NodeFrame>()

  for (const [id, s] of start.nodes) {
    const view = target.nodes.get(id) ?? s.view
    const center = target.visible.has(id) ? layout.nodes.get(id) : undefined
    const owner = plan.members.get(id) ?? ""
    const settled = {
      view,
      previous: undefined,
      mix: 1,
    }

    if (plan.expand.includes(id)) {
      nodes.set(id, {
        ...s,
        center: lerpPoint(s.center, openAt(id), move),
        scale: lerp(s.scale, layout.scale, move),
        opacity: s.opacity * (1 - clamp(unfold * 2)),
      })
      continue
    }

    if (plan.expand.includes(owner) && center !== undefined) {
      nodes.set(id, {
        ...settled,
        center: lerpPoint(openAt(owner), center, unfold),
        size: lerpSize(boxSize(owner), view.size, unfold),
        scale: layout.scale,
        opacity: unfold,
      })
      continue
    }

    const closing = closeFrom(plan.collapse.includes(id) ? id : owner)

    if (plan.collapse.includes(id) && center !== undefined && closing !== undefined) {
      nodes.set(id, {
        ...settled,
        center: lerpPoint(rectCenter(closing.rect), center, move),
        size: view.size,
        scale: lerp(closing.scale, layout.scale, move),
        opacity: clamp(disappear * 2 - 1),
      })
      continue
    }

    if (plan.collapse.includes(owner) && closing !== undefined) {
      nodes.set(id, {
        ...s,
        center: lerpPoint(s.center, rectCenter(closing.rect), disappear),
        size: lerpSize(s.size, target.nodes.get(owner)?.size ?? s.size, disappear),
        scale: lerp(s.scale, closing.scale, disappear),
        opacity: s.opacity * (1 - disappear),
      })
      continue
    }

    if (center === undefined) {
      const into = morphTo(id)
      const partner = into.length === 1 ? into[0] : undefined
      const partnerCenter = partner === undefined ? undefined : layout.nodes.get(partner)
      const partnerView = partner === undefined ? undefined : target.nodes.get(partner)

      if (partnerCenter !== undefined && partnerView !== undefined) {
        nodes.set(id, {
          ...s,
          center: lerpPoint(s.center, partnerCenter, move),
          size: lerpSize(s.size, partnerView.size, move),
          scale: lerp(s.scale, layout.scale, move),
          opacity: s.opacity * (1 - morphOut(move)),
        })
        continue
      }

      const fade = into.length > 0 ? morphOut(move) : disappear
      nodes.set(id, {
        ...s,
        scale: s.scale * (1 - 0.14 * fade),
        opacity: s.opacity * (1 - fade),
      })
      continue
    }

    const sources = morphFrom(id)
    const source = sources.length === 1 ? start.nodes.get(sources[0] ?? "") : undefined

    if (sources.length > 0) {
      nodes.set(id, {
        center: source === undefined ? center : lerpPoint(source.center, center, move),
        size: source === undefined ? view.size : lerpSize(source.size, view.size, move),
        scale: source === undefined ? layout.scale : lerp(source.scale, layout.scale, move),
        opacity: morphIn(move),
        view,
        previous: undefined,
        mix: 1,
      })
      continue
    }

    if (s.opacity <= 0.01) {
      const grow = appearOf(id)
      nodes.set(id, {
        center,
        size: view.size,
        scale: layout.scale * (0.86 + 0.14 * grow),
        opacity: grow,
        view,
        previous: undefined,
        mix: 1,
      })
      continue
    }

    const before = shownView(s)
    const changed = !sameContent(before, view)
    nodes.set(id, {
      center: lerpPoint(s.center, center, move),
      size: lerpSize(s.size, view.size, move),
      scale: lerp(s.scale, layout.scale, move),
      opacity: lerp(s.opacity, 1, appearing.has(id) ? appearOf(id) : move),
      view,
      previous: changed ? before : undefined,
      mix: changed ? move : 1,
    })
  }

  const notes = new Map<string, NoteFrame>()

  for (const [id, s] of start.notes) {
    const center = target.visible.has(id) ? layout.notes.get(id) : undefined

    if (center === undefined) {
      notes.set(id, {
        ...s,
        opacity: s.opacity * (1 - disappear),
      })
      continue
    }

    const grow = appearOf(id)
    notes.set(
      id,
      s.opacity <= 0.01
        ? {
            center,
            scale: layout.scale * (0.9 + 0.1 * grow),
            opacity: grow,
          }
        : {
            center: lerpPoint(s.center, center, move),
            scale: lerp(s.scale, layout.scale, move),
            opacity: lerp(s.opacity, 1, appearing.has(id) ? grow : move),
          },
    )
  }

  const groups = new Map<string, GroupFrame>()

  for (const [id, s] of start.groups) {
    const rect = target.visible.has(id) ? layout.groups.get(id) : undefined

    if (plan.expand.includes(id) && rect !== undefined) {
      groups.set(id, {
        rect: lerpRect(boxAt(openAt(id), boxSize(id), layout.scale), rect, unfold),
        scale: layout.scale,
        opacity: unfold,
      })
      continue
    }

    if (plan.collapse.includes(id)) {
      const box = boxAt(rectCenter(s.rect), target.nodes.get(id)?.size ?? [0, 0], s.scale)
      groups.set(id, {
        ...s,
        rect: lerpRect(s.rect, box, disappear),
        opacity: s.opacity * (1 - disappear),
      })
      continue
    }

    if (rect === undefined) {
      groups.set(id, {
        ...s,
        opacity: s.opacity * (1 - disappear),
      })
      continue
    }

    const grow = appearOf(id)
    groups.set(
      id,
      s.opacity <= 0.01
        ? {
            rect,
            scale: layout.scale,
            opacity: grow,
          }
        : {
            rect: lerpRect(s.rect, rect, move),
            scale: lerp(s.scale, layout.scale, move),
            opacity: lerp(s.opacity, 1, appearing.has(id) ? grow : move),
          },
    )
  }

  const edges = new Map<string, EdgeFrame>()

  for (const [id, s] of start.edges) {
    const route = target.visible.has(id) ? layout.edges.get(id) : undefined
    const [from, to] = target.ends.get(id) ?? [s.from, s.to]
    // An edge moves from a closing composite's members to its box once they have shrunk into it, and from an
    // opening one's box to its members as they start to grow.
    const closing = [s.from, s.to].some((end) => plan.collapse.includes(plan.members.get(end) ?? ""))
    const ends = t >= (closing ? windows.move.start : windows.appear.start) ? { from, to } : { from: s.from, to: s.to }

    if (route === undefined) {
      edges.set(id, {
        from: s.from,
        to: s.to,
        route: s.route,
        draw: s.draw * (1 - retract),
        label: s.label * (1 - clamp(retract * 2.5)),
      })
      continue
    }

    const begin = windows.draw.start + delay(id)
    const line = progress(begin, timing.draw * 0.7, t)
    const label = progress(begin + timing.draw * 0.6, timing.draw * 0.4, t)

    edges.set(
      id,
      s.draw <= 0.01
        ? {
            from,
            to,
            route,
            draw: line,
            label,
          }
        : {
            ...ends,
            route: lerpRoute(s.route, route, move),
            draw: lerp(s.draw, 1, drawing.has(id) ? line : move),
            label: lerp(s.label, 1, drawing.has(id) ? label : move),
          },
    )
  }

  return {
    scale: lerp(start.scale, layout.scale, move),
    nodes,
    notes,
    groups,
    edges,
  }
}
