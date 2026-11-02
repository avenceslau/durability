import type { ReactNode } from "react"

import type { Point } from "./geometry.ts"
import { type IconName, isIconName } from "./icons/names.ts"
import { layoutStage, NODE, noteSize, spreadPorts, stackOffset, type StageLayout, textWidth } from "./layout.ts"
import { snapPositions } from "./snap.ts"

export { NODE } from "./layout.ts"
export type { EdgeRoute, StageLayout } from "./layout.ts"

export type FlowColor = "blue" | "red" | "green" | "orange" | "purple"

/** How an edge runs: a smooth curve, a straight line, or horizontal and vertical runs joined by rounded corners. */
export type EdgeShape = "curve" | "straight" | "orthogonal"

export interface FlowDefinition {
  /** Names the flow for screen readers while it is spotlit. */
  readonly label: string
  /** Picks the template's `--flow-<color>` token for the flow's edges. */
  readonly color: FlowColor
}

/** What a node shows; a stage can change any of it in place with a `set` token. */
export interface NodeContent {
  readonly label: string
  readonly sublabel?: string
  /** A built-in icon name or any SVG element; a nested `<svg viewBox>` fills the icon's square. */
  readonly icon?: IconName | ReactNode
  /** Something outside the system being drawn, such as the customer's code. */
  readonly tone?: "external"
  /** Draws the node as a stack of cards with a "×n" badge: many instances of one thing. 1 is a single card. */
  readonly replicas?: number
}

/** Fields a `set` token changes; `undefined` clears an optional one. */
export type NodeChanges = {
  readonly [Key in keyof NodeContent]?: NodeContent[Key] | undefined
}

export interface NodeDefinition extends NodeContent {
  readonly iconAt?: "left" | "top"
  /** Centre in canvas coordinates: required in manual layout; in auto layout it pins the node, like `pin`. */
  readonly at?: Point
  /** Auto layout: keep the node at this canvas position instead of placing it. */
  readonly pin?: Point
  /** Width and height; estimated from the labels when omitted. */
  readonly size?: readonly [number, number]
  /** Auto layout: put the node in this rank (0 is the first), instead of the one its edges give it. */
  readonly rank?: number
  /** Auto layout: the grid row to aim for within its rank (0 is the top in `right` diagrams). */
  readonly row?: number
  /** Auto layout: put the node in the rank after this one. */
  readonly after?: string
  /** Auto layout: put the node in the same rank as this one, just below it (to its right in `down` diagrams). */
  readonly below?: string
  /** Auto layout: put the node in the same rank as this one, just above it (to its left in `down` diagrams). */
  readonly above?: string
  /** Nodes this one takes over from: when they leave as it arrives, it grows out of them instead of fading in. */
  readonly replaces?: string | ReadonlyArray<string>
  /**
   * Makes the node a composite of these nodes, which follow it on and off stage. Collapsed, it draws as one box
   * that takes over their edges; expanded, as a group round them. A click toggles it while presenting.
   */
  readonly contains?: ReadonlyArray<string>
  /** A composite starts collapsed; `expand:<id>` and `collapse:<id>` stage tokens change that. */
  readonly collapsed?: boolean
}

export interface EdgeDefinition {
  /** Defaults to `from->to`; needed only when two edges join the same nodes in the same direction. */
  readonly id?: string
  readonly from: string
  readonly to: string
  /** Use `\n` for a line break. */
  readonly label?: string
  readonly flow?: string
  /** Sideways bow from −1 to 1, as a fraction of the distance between the nodes; positive bows left of travel. */
  readonly bend?: number
  /** Overrides the diagram's `routing` for this edge. */
  readonly route?: EdgeShape
  /** Arrowheads at both ends. */
  readonly both?: boolean
  /** Auto layout: a reply or loop that shouldn't push its target into a later rank. */
  readonly back?: boolean
  /** The first stage the edge may appear in; without it, the edge appears as soon as both nodes are shown. */
  readonly stage?: number
  /** Where the label sits along the edge, from 0 (start) to 1 (end); auto layout slides it clear of nodes. */
  readonly labelAt?: number
}

export interface NoteDefinition {
  readonly id: string
  /** Use `\n` for a line break. */
  readonly text: string
  /** Centre of the note in canvas coordinates. */
  readonly at?: Point
  /** The node the note sits beside, when it has no `at`. */
  readonly near?: string
  /** Which side of `near` to try first; the others are tried if it is taken. Defaults to `bottom`. */
  readonly side?: "top" | "bottom" | "left" | "right"
}

export interface GroupDefinition {
  readonly id: string
  readonly label: string
  /** Node ids the group's box surrounds. */
  readonly contains: ReadonlyArray<string>
}

/** A stage change: an id token (see `stages`), or `{ set: { nodeId: { label: "v2" } } }` to change nodes in place. */
export type StageToken =
  | string
  | {
      readonly set: Readonly<Record<string, NodeChanges>>
    }

export interface ArchitectureDefinition {
  /** The coordinate space of every position; the drawing scales to fit its container. */
  readonly canvas: {
    readonly width: number
    readonly height: number
  }
  /** `auto` (the default) lays out each stage's shown nodes; `manual` keeps every node at its `at`. */
  readonly layout?: "auto" | "manual"
  /** The way auto layout's ranks run. Defaults to `right`. */
  readonly direction?: "right" | "down"
  /**
   * How edges run unless they set `route`. `auto` runs edges between nodes in different rows orthogonally, through
   * the gaps between rows and columns, and curves the rest. Defaults to `curve`.
   */
  readonly routing?: "auto" | EdgeShape
  /**
   * Lines up hand-placed positions (`at` and `pin`): coordinates within `tolerance` canvas units share a row or
   * column, and nearly even gaps become even. On by default with 4% of the canvas's longer side; `false` turns it off.
   */
  readonly snap?:
    | false
    | {
        readonly tolerance?: number
      }
  readonly flows?: Readonly<Record<string, FlowDefinition>>
  readonly nodes: Readonly<Record<string, NodeDefinition>>
  readonly edges?: ReadonlyArray<EdgeDefinition>
  readonly notes?: ReadonlyArray<NoteDefinition>
  readonly groups?: ReadonlyArray<GroupDefinition>
  /**
   * Builds, each a list of changes to the one before: `id` or `+id` shows a node, note, or group, `-id` hides it,
   * and `prefix*` matches several. `-edgeId` hides an edge that would show (`+edgeId` brings it back).
   * `flow:<name>` or `focus:<id>` spotlights a flow or a node for that stage only. `expand:<id>` and
   * `collapse:<id>` open and close a composite from that stage on. `{ set: { id: changes } }` changes what a node
   * shows from that stage on. Nodes inside a composite follow it, so tokens name the composite.
   */
  readonly stages?: ReadonlyArray<ReadonlyArray<StageToken>>
}

export interface DiagramNode extends Omit<NodeDefinition, "replaces" | "contains"> {
  readonly id: string
  readonly replaces: ReadonlyArray<string>
  /** Empty unless the node is a composite. */
  readonly contains: ReadonlyArray<string>
}

/** What a node shows in one stage, with its unscaled size. */
export interface NodeView {
  readonly label: string
  readonly sublabel: string | undefined
  readonly icon: IconName | ReactNode
  readonly iconAt: "left" | "top" | undefined
  readonly tone: "external" | undefined
  readonly replicas: number | undefined
  readonly size: readonly [number, number]
}

export interface DiagramEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly label: string | undefined
  readonly labelAt: number | undefined
  readonly flow: string | undefined
  readonly color: FlowColor | undefined
  readonly bend: number | undefined
  readonly route: EdgeShape | undefined
  readonly both: boolean
  readonly back: boolean
  readonly stage: number
}

export interface DiagramNote {
  readonly id: string
  readonly text: string
  /** Unscaled width and height of the text. */
  readonly size: readonly [number, number]
  readonly at: Point | undefined
  readonly near: string | undefined
  readonly side: NoteDefinition["side"]
}

export interface DiagramGroup {
  readonly id: string
  readonly label: string
  readonly contains: ReadonlyArray<string>
  /** An expanded composite, drawn round its members, with the composite's id. */
  readonly composite: boolean
}

export type Spotlight =
  | {
      readonly kind: "flow"
      readonly flow: string
      readonly label: string
    }
  | {
      readonly kind: "focus"
      readonly id: string
    }

export interface StageState {
  /** Node, note, group, and edge ids shown in the stage. */
  readonly visible: ReadonlySet<string>
  readonly spotlight: Spotlight | undefined
  /** Ids kept at full strength by the spotlight; everything else is dimmed. */
  readonly lit: ReadonlySet<string>
  /** What every node shows in the stage, shown or not. */
  readonly nodes: ReadonlyMap<string, NodeView>
  /** Composites drawn as a group round their members when shown; the others draw as one box. */
  readonly expanded: ReadonlySet<string>
  /** The nodes each routed edge joins: a collapsed composite takes over the edges of the nodes inside it. */
  readonly ends: ReadonlyMap<string, readonly [string, string]>
  /**
   * Where the shown elements are, and the edges later stages add between them, which are routed now so nothing
   * moves when they appear. Ports are spread over the shown edges only, so the edges already there slide along
   * their sides as new ones join. Stages that show the same things share one layout.
   */
  readonly layout: StageLayout
}

export interface ArchitectureDiagram {
  readonly canvas: ArchitectureDefinition["canvas"]
  readonly nodes: ReadonlyArray<DiagramNode>
  readonly edges: ReadonlyArray<DiagramEdge>
  readonly notes: ReadonlyArray<DiagramNote>
  /** The definition's groups, then a group for each composite. */
  readonly groups: ReadonlyArray<DiagramGroup>
  readonly stages: ReadonlyArray<StageState>
  /** A stage with its composites expanded or collapsed otherwise, as a click leaves them; cached. */
  readonly stageWith: (index: number, expanded: ReadonlySet<string>) => StageState
}

const ID_PATTERN = /^[A-Za-z_][\w-]*$/

function fail(message: string): never {
  throw new Error(`Architecture: ${message}`)
}

function viewOf(node: DiagramNode, changes: NodeChanges | undefined): NodeView {
  const content = {
    label: node.label,
    sublabel: node.sublabel,
    icon: node.icon,
    tone: node.tone,
    replicas: node.replicas,
    ...changes,
  }

  return {
    label: content.label ?? node.label,
    sublabel: content.sublabel,
    icon: content.icon,
    iconAt: node.iconAt,
    tone: content.tone,
    replicas: content.replicas,
    size: node.size ?? measureNode(content.label ?? node.label, content.sublabel, content.icon, node.iconAt),
  }
}

function measureNode(
  label: string,
  sublabel: string | undefined,
  icon: unknown,
  iconAt: "left" | "top" | undefined,
): readonly [number, number] {
  const text = Math.max(textWidth(label, NODE.labelSize), textWidth(sublabel ?? "", NODE.sublabelSize))

  if (iconAt === "top") {
    const height = NODE.padding * 2 + NODE.topIcon + 12 + NODE.labelSize + (sublabel === undefined ? 0 : 24)
    return [Math.max(text + NODE.padding * 2, height), height]
  }

  const iconWidth = icon === undefined ? 0 : NODE.icon + NODE.iconGap
  return [Math.round(NODE.padding * 2 + iconWidth + text), NODE.height]
}

function checkContent(where: string, content: NodeChanges): void {
  if (typeof content.icon === "string" && !isIconName(content.icon)) {
    fail(`${where} uses unknown icon "${content.icon}"`)
  }

  if (content.replicas !== undefined && (!Number.isInteger(content.replicas) || content.replicas < 1)) {
    fail(`${where} has replicas ${content.replicas}; use a whole number of at least 1`)
  }
}

function checkNode(
  id: string,
  node: NodeDefinition,
  nodeIds: ReadonlySet<string>,
  mode: "auto" | "manual",
): DiagramNode {
  const where = `node "${id}"`
  checkContent(where, node)

  if (mode === "manual" && node.at === undefined && node.pin === undefined) {
    fail(`${where} has no \`at\`; manual layout needs a position for every node`)
  }

  if (node.rank !== undefined && (!Number.isInteger(node.rank) || node.rank < 0)) {
    fail(`${where} has rank ${node.rank}; use a whole number from 0`)
  }

  const replaces = node.replaces === undefined ? [] : typeof node.replaces === "string" ? [node.replaces] : node.replaces
  const references = [
    ["after", node.after],
    ["below", node.below],
    ["above", node.above],
    ...replaces.map((other) => ["replaces", other] as const),
  ] as const

  for (const [hint, other] of [...references, ...(node.contains ?? []).map((other) => ["contains", other] as const)]) {
    if (other !== undefined && (other === id || !nodeIds.has(other))) {
      fail(`${where} has ${hint} "${other}", which is ${other === id ? "itself" : "not a node"}`)
    }
  }

  if (node.contains?.length === 0) {
    fail(`${where} contains no nodes; omit \`contains\` for a plain node`)
  }

  return {
    ...node,
    id,
    replaces,
    contains: node.contains ?? [],
  }
}

/** Each node belongs to one composite at most, and composites don't nest. */
function checkComposites(nodes: ReadonlyArray<DiagramNode>): ReadonlyMap<string, string> {
  const parentOf = new Map<string, string>()

  for (const node of nodes) {
    for (const child of node.contains) {
      const other = parentOf.get(child)

      if (other !== undefined) {
        fail(`node "${child}" is in composites "${other}" and "${node.id}"; a node belongs to one at most`)
      }

      parentOf.set(child, node.id)
    }
  }

  for (const node of nodes) {
    const parent = parentOf.get(node.id)

    if (parent !== undefined && node.contains.length > 0) {
      fail(`composite "${node.id}" is inside composite "${parent}"; composites nest one level deep only`)
    }
  }

  return parentOf
}

function checkEdge(edge: EdgeDefinition, nodeIds: ReadonlySet<string>, flows: Readonly<Record<string, FlowDefinition>>): DiagramEdge {
  const id = edge.id ?? `${edge.from}->${edge.to}`

  for (const end of [edge.from, edge.to]) {
    if (!nodeIds.has(end)) {
      fail(`edge "${id}" joins unknown node "${end}"`)
    }
  }

  if (edge.flow !== undefined && !Object.hasOwn(flows, edge.flow)) {
    fail(`edge "${id}" belongs to unknown flow "${edge.flow}"; declare it in \`flows\``)
  }

  if (edge.bend !== undefined && (edge.bend < -1 || edge.bend > 1)) {
    fail(`edge "${id}" has bend ${edge.bend}; use a value from -1 to 1`)
  }

  return {
    id,
    from: edge.from,
    to: edge.to,
    label: edge.label,
    labelAt: edge.labelAt,
    flow: edge.flow,
    color: edge.flow === undefined ? undefined : flows[edge.flow]?.color,
    bend: edge.bend,
    route: edge.route,
    both: edge.both ?? false,
    back: edge.back ?? false,
    stage: edge.stage ?? 0,
  }
}

function checkNote(note: NoteDefinition, nodeIds: ReadonlySet<string>): DiagramNote {
  if (note.near !== undefined && !nodeIds.has(note.near)) {
    fail(`note "${note.id}" is near unknown node "${note.near}"`)
  }

  if (note.at === undefined && note.near === undefined) {
    fail(`note "${note.id}" needs \`at\` or \`near\``)
  }

  return {
    id: note.id,
    text: note.text,
    size: noteSize(note.text),
    at: note.at,
    near: note.near,
    side: note.side,
  }
}

function checkGroup(group: GroupDefinition, nodeIds: ReadonlySet<string>): DiagramGroup {
  if (group.contains.length === 0) {
    fail(`group "${group.id}" contains no nodes`)
  }

  for (const id of group.contains) {
    if (!nodeIds.has(id)) {
      fail(`group "${group.id}" contains unknown node "${id}"`)
    }
  }

  return {
    ...group,
    composite: false,
  }
}

function matchIds(pattern: string, ids: ReadonlyArray<string>, where: string): ReadonlyArray<string> {
  if (!pattern.includes("*")) {
    if (!ids.includes(pattern)) {
      fail(`${where} names unknown id "${pattern}"; nodes, notes, and groups are ${ids.join(", ")}`)
    }

    return [pattern]
  }

  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
  const expression = new RegExp(`^${source}$`)
  const matches = ids.filter((id) => expression.test(id))

  if (matches.length === 0) {
    fail(`${where} matches no ids`)
  }

  return matches
}

/** The ids a spotlight keeps lit: its edges and their ends, plus the focused node itself. */
function lightUp(
  token: string,
  where: string,
  visible: ReadonlySet<string>,
  shown: ReadonlyArray<DiagramEdge>,
  flows: Readonly<Record<string, FlowDefinition>>,
): {
  readonly spotlight: Spotlight
  readonly lit: ReadonlySet<string>
} {
  const [kind, name = ""] = token.split(":")
  const lit = new Set<string>()
  let spotlight: Spotlight
  let edges: ReadonlyArray<DiagramEdge>

  if (kind === "flow") {
    const flow = flows[name]

    if (flow === undefined) {
      fail(`${where} spotlights unknown flow "${name}"`)
    }

    spotlight = {
      kind: "flow",
      flow: name,
      label: flow.label,
    }
    edges = shown.filter((edge) => edge.flow === name)

    if (edges.length === 0) {
      fail(`${where} spotlights a flow with no edges shown in this stage`)
    }
  } else {
    if (!visible.has(name)) {
      fail(`${where} focuses on "${name}", which is not shown in this stage`)
    }

    spotlight = {
      kind: "focus",
      id: name,
    }
    edges = shown.filter((edge) => edge.from === name || edge.to === name)
    lit.add(name)
  }

  for (const edge of edges) {
    lit.add(edge.id)
    lit.add(edge.from)
    lit.add(edge.to)
  }

  return {
    spotlight,
    lit,
  }
}

interface Parts {
  readonly canvas: ArchitectureDefinition["canvas"]
  readonly pins: ReadonlyMap<string, Point>
  readonly mode: "auto" | "manual"
  readonly direction: "right" | "down"
  readonly routing: "auto" | EdgeShape
  readonly nodes: ReadonlyArray<DiagramNode>
  readonly edges: ReadonlyArray<DiagramEdge>
  readonly notes: ReadonlyArray<DiagramNote>
  readonly groups: ReadonlyArray<DiagramGroup>
  readonly flows: Readonly<Record<string, FlowDefinition>>
  /** The composite each node inside one belongs to. */
  readonly parentOf: ReadonlyMap<string, string>
}

/** What decides a stage's layout; stages that differ only in spotlight share one. */
function layoutKey(visible: ReadonlySet<string>, views: ReadonlyMap<string, NodeView>): string {
  const sizes = [...views]
    .filter(([id]) => visible.has(id))
    .map(([id, view]) => `${id}:${view.size.join("x")}:${view.replicas ?? 1}`)
  return [...[...visible].sort(), ...sizes].join("|")
}

/** A stage's tokens applied, before its composites open or close. */
interface TokenStage {
  /** Nodes outside composites, notes, and groups. */
  readonly items: ReadonlySet<string>
  /** Edges the stage shows between its items' nodes, before collapsed composites take any over. */
  readonly edges: ReadonlyArray<DiagramEdge>
  readonly spotlight: string | undefined
  readonly views: ReadonlyMap<string, NodeView>
  readonly expanded: ReadonlySet<string>
}

/** What a stage draws once its composites are open or closed. */
interface Display {
  /** Nodes drawn as boxes, collapsed composites among them. */
  readonly nodes: ReadonlySet<string>
  /** Expanded composites, drawn as groups. */
  readonly composites: ReadonlySet<string>
  /** The node drawn for a node: itself, or the outermost collapsed composite holding it. */
  readonly standIn: (id: string) => string
}

function ancestors(parentOf: ReadonlyMap<string, string>, id: string): ReadonlyArray<string> {
  const chain: string[] = []

  for (let up = parentOf.get(id); up !== undefined; up = parentOf.get(up)) {
    chain.push(up)
  }

  return chain
}

function displayOf(parts: Parts, items: ReadonlySet<string>, expanded: ReadonlySet<string>): Display {
  const standIn = (id: string): string =>
    [id, ...ancestors(parts.parentOf, id).filter((up) => !expanded.has(up))].at(-1) ?? id
  const nodes = new Set<string>()
  const composites = new Set<string>()

  for (const node of parts.nodes) {
    const outermost = ancestors(parts.parentOf, node.id).at(-1) ?? node.id

    if (!items.has(outermost) || standIn(node.id) !== node.id) {
      continue
    }

    if (node.contains.length > 0 && expanded.has(node.id)) {
      composites.add(node.id)
    } else {
      nodes.add(node.id)
    }
  }

  return {
    nodes,
    composites,
    standIn,
  }
}

/**
 * Edges between the nodes drawn, each joining the nodes drawn for its ends. Edges inside a collapsed composite
 * drop out, and of the edges it takes over, one per pair of ends, way, and flow is kept.
 */
function edgesThrough(display: Display, edges: ReadonlyArray<DiagramEdge>, taken: Set<string>): Array<DiagramEdge> {
  return edges.flatMap((edge) => {
    const from = display.standIn(edge.from)
    const to = display.standIn(edge.to)
    const key = `${from}|${to}|${edge.flow ?? ""}`
    const retargeted = from !== edge.from || to !== edge.to

    if (from === to || !display.nodes.has(from) || !display.nodes.has(to) || (retargeted && taken.has(key))) {
      return []
    }

    taken.add(key)
    return [
      {
        ...edge,
        from,
        to,
      },
    ]
  })
}

/**
 * Ranks and rows hints aimed at a node inside a collapsed composite aim at the composite, and those aimed at an
 * expanded composite aim at its first child.
 */
function aimHints(node: DiagramNode, standIn: (id: string) => string): DiagramNode {
  const { after, below, above, ...rest } = node
  const hints = Object.entries({ after, below, above }).flatMap(([hint, anchor]) => {
    const target = anchor === undefined ? undefined : standIn(anchor)
    return target === undefined || target === node.id ? [] : [[hint, target] as const]
  })

  return {
    ...rest,
    ...Object.fromEntries(hints),
  }
}

function resolveStages(
  parts: Parts,
  stages: ReadonlyArray<ReadonlyArray<StageToken>>,
): Pick<ArchitectureDiagram, "stages" | "stageWith"> {
  const { parentOf } = parts
  const itemIds = [
    ...parts.nodes.filter((node) => !parentOf.has(node.id)).map((node) => node.id),
    ...parts.notes.map((note) => note.id),
    ...parts.groups.map((group) => group.id),
  ]
  const nodeIds = new Set(parts.nodes.map((node) => node.id))
  const edgeIds = new Set(parts.edges.map((edge) => edge.id))
  const composites = new Set(parts.nodes.filter((node) => node.contains.length > 0).map((node) => node.id))
  const outermost = (id: string): string => ancestors(parentOf, id).at(-1) ?? id
  const visible = new Set<string>()
  const hiddenEdges = new Set<string>()
  const changes = new Map<string, NodeChanges>()
  const expanded = new Set(
    parts.nodes.filter((node) => composites.has(node.id) && node.collapsed !== true).map((node) => node.id),
  )

  const tokenStages = stages.map((tokens, index): TokenStage => {
    let spotlightToken: string | undefined

    for (const token of tokens) {
      if (typeof token !== "string") {
        for (const [id, change] of Object.entries(token.set)) {
          if (!nodeIds.has(id)) {
            fail(`stage ${index} sets unknown node "${id}"`)
          }

          checkContent(`stage ${index} set "${id}"`, change)
          changes.set(id, {
            ...changes.get(id),
            ...change,
          })
        }

        continue
      }

      const where = `stage ${index} token "${token}"`

      if (token.startsWith("flow:") || token.startsWith("focus:")) {
        if (spotlightToken !== undefined) {
          fail(`${where}: a stage takes one spotlight and already has "${spotlightToken}"`)
        }

        spotlightToken = token
        continue
      }

      if (token.startsWith("expand:") || token.startsWith("collapse:")) {
        const [kind, id = ""] = token.split(":")

        if (!composites.has(id)) {
          fail(`${where} names "${id}", which is not a composite; give a node \`contains\` to make one`)
        }

        if (kind === "expand") {
          expanded.add(id)
        } else {
          expanded.delete(id)
        }

        continue
      }

      if (token.includes(":")) {
        fail(
          `${where} is not a known kind of token; use flow:<name>, focus:<id>, expand:<id>, collapse:<id>, or a { set } object`,
        )
      }

      const remove = token.startsWith("-")
      const pattern = remove || token.startsWith("+") ? token.slice(1) : token

      if (edgeIds.has(pattern)) {
        if (remove) {
          hiddenEdges.add(pattern)
        } else {
          hiddenEdges.delete(pattern)
        }

        continue
      }

      const parent = parentOf.get(pattern)

      if (parent !== undefined) {
        fail(`${where} names "${pattern}", which is inside composite "${parent}"; name the composite, and expand:${parent} opens it`)
      }

      for (const id of matchIds(pattern, itemIds, where)) {
        if (remove) {
          visible.delete(id)
        } else {
          visible.add(id)
        }
      }
    }

    return {
      items: new Set(visible),
      edges: parts.edges.filter(
        (edge) =>
          visible.has(outermost(edge.from)) &&
          visible.has(outermost(edge.to)) &&
          edge.stage <= index &&
          !hiddenEdges.has(edge.id),
      ),
      spotlight: spotlightToken,
      views: new Map(parts.nodes.map((node) => [node.id, viewOf(node, changes.get(node.id))])),
      expanded: new Set(expanded),
    }
  })

  const descendants = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
    ids.flatMap((id) => [id, ...descendants(parts.nodes.find((node) => node.id === id)?.contains ?? [])])
  const bases = new Map<string, StageLayout>()
  const spread = new Map<string, StageLayout>()

  const build = (index: number, open: ReadonlySet<string>, previous: StageLayout | undefined, strict: boolean): StageState => {
    const stage = tokenStages[index]

    if (stage === undefined) {
      fail(`there is no stage ${index}`)
    }

    const display = displayOf(parts, stage.items, open)
    const taken = new Set<string>()
    const shown = edgesThrough(display, stage.edges, taken)
    // Edges a later stage adds between nodes already here take part now, so nothing moves when they appear.
    const later = new Set(tokenStages.slice(index + 1).flatMap((other) => other.edges))
    const upcoming = edgesThrough(
      display,
      parts.edges.filter((edge) => later.has(edge) && !stage.edges.includes(edge)),
      taken,
    )
    const state = new Set([
      ...display.nodes,
      ...display.composites,
      ...[...stage.items].filter((id) => !nodeIds.has(id)),
      ...shown.map((edge) => edge.id),
    ])
    const spotlight = (): ReturnType<typeof lightUp> | undefined =>
      stage.spotlight === undefined
        ? undefined
        : lightUp(stage.spotlight, `stage ${index} token "${stage.spotlight}"`, state, shown, parts.flows)
    let spotlit: ReturnType<typeof lightUp> | undefined

    try {
      spotlit = spotlight()
    } catch (error) {
      // A click can hide what a stage spotlights; the stage itself was checked when the diagram was defined.
      if (strict) {
        throw error
      }
    }

    const members = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
      parts.mode === "manual" ? descendants(ids) : descendants(ids).filter((id) => display.nodes.has(id))
    const key = layoutKey(new Set([...state, ...upcoming.map((edge) => edge.id)]), stage.views)
    const base =
      bases.get(key) ??
      layoutStage(
        {
          canvas: parts.canvas,
          mode: parts.mode,
          direction: parts.direction,
          routing: parts.routing,
          nodes: parts.nodes
            .filter((node) => display.nodes.has(node.id))
            .map((node) =>
              aimHints(node, (id) => {
                const target = display.standIn(id)
                const first = parts.nodes.find((other) => other.id === target)?.contains[0]
                return display.composites.has(target) && first !== undefined ? first : target
              }),
            ),
          views: stage.views,
          edges: [...shown, ...upcoming],
          notes: parts.notes
            .filter((note) => stage.items.has(note.id))
            .map((note) => ({
              ...note,
              near: note.near === undefined ? undefined : display.standIn(note.near),
            })),
          groups: [
            // Composites first, so their members keep together inside any group round them.
            ...parts.nodes
              .filter((node) => display.composites.has(node.id))
              .map((node) => ({
                id: node.id,
                label: stage.views.get(node.id)?.label ?? node.label,
                contains: members(node.contains),
                composite: true,
              })),
            ...parts.groups
              .filter((group) => stage.items.has(group.id))
              .map((group) => ({
                ...group,
                contains: members(group.contains),
              })),
          ],
          previous,
          pins: parts.pins,
        },
        parts.nodes,
      )
    bases.set(key, base)

    const shownKey = `${key}#${shown.map((edge) => edge.id).join("|")}`
    const layout =
      spread.get(shownKey) ??
      spreadPorts(
        base,
        shown,
        stage.views,
        parts.notes.filter((note) => stage.items.has(note.id)),
      )
    spread.set(shownKey, layout)

    return {
      visible: state,
      spotlight: spotlit?.spotlight,
      lit: spotlit?.lit ?? new Set(),
      nodes: stage.views,
      expanded: open,
      ends: new Map([...shown, ...upcoming].map((edge) => [edge.id, [edge.from, edge.to] as const])),
      layout,
    }
  }

  let previous: StageLayout | undefined
  const resolved = tokenStages.map((stage, index) => {
    const state = build(index, stage.expanded, previous, true)
    previous = state.layout
    return state
  })
  const variants = new Map<string, StageState>()

  return {
    stages: resolved,
    stageWith: (index, open) => {
      const own = resolved[index]
      const key = `${index}|${[...open].sort().join(",")}`
      const ownKey = `${index}|${[...(own?.expanded ?? [])].sort().join(",")}`

      if (own !== undefined && key === ownKey) {
        return own
      }

      const state = variants.get(key) ?? build(index, new Set(open), own?.layout, false)
      variants.set(key, state)
      return state
    },
  }
}

/** Whether each composite a presenter clicked is open; a click wins over every build's tokens until the slide changes. */
export type CompositeClicks = ReadonlyMap<string, boolean>

/** The stage a build shows: its own, with each clicked composite open or closed as the click left it. */
export function shownStage(diagram: ArchitectureDiagram, index: number, clicks: CompositeClicks): StageState {
  const own = diagram.stages[index] ?? diagram.stages.at(-1)

  if (own === undefined) {
    fail("the diagram has no stages")
  }

  if (clicks.size === 0) {
    return own
  }

  const expanded = new Set(own.expanded)

  for (const [id, open] of clicks) {
    if (open) {
      expanded.add(id)
    } else {
      expanded.delete(id)
    }
  }

  return diagram.stageWith(Math.min(index, diagram.stages.length - 1), expanded)
}

/** The clicks after one more on composite `id`, which flips it from however `shown` draws it. */
export function clickComposite(clicks: CompositeClicks, shown: StageState, id: string): CompositeClicks {
  return new Map([...clicks, [id, !shown.expanded.has(id)]])
}

/** Where placed nodes and notes go: their `pin` or `at`, snapped into rows and columns unless `snap` is false. */
function pinPositions(
  definition: ArchitectureDefinition,
  nodes: ReadonlyArray<DiagramNode>,
  notes: ReadonlyArray<DiagramNote>,
): ReadonlyMap<string, Point> {
  const items = [
    ...nodes.flatMap((node) => {
      const point = node.pin ?? node.at
      const view = viewOf(node, undefined)
      const stack = stackOffset(view.replicas)
      return point === undefined
        ? []
        : [
            {
              id: node.id,
              point,
              size: [view.size[0] + stack, view.size[1] + stack] as const,
              anchor: true,
            },
          ]
    }),
    ...notes.flatMap((note) =>
      note.at === undefined
        ? []
        : [
            {
              id: note.id,
              point: note.at,
              size: note.size,
              anchor: false,
            },
          ],
    ),
  ]

  if (definition.snap === false) {
    return new Map(items.map((item) => [item.id, item.point]))
  }

  const { width, height } = definition.canvas
  return snapPositions(items, definition.snap?.tolerance ?? Math.max(width, height) * 0.04)
}

function checkIds(ids: ReadonlyArray<string>, explicit: ReadonlyArray<string>): void {
  for (const id of explicit) {
    if (!ID_PATTERN.test(id)) {
      fail(`id "${id}" must start with a letter or _ and use only letters, digits, _, and -`)
    }
  }

  const seen = new Set<string>()

  for (const id of ids) {
    if (seen.has(id)) {
      fail(`id "${id}" is used twice; nodes, notes, groups, and edges share one set of ids`)
    }

    seen.add(id)
  }
}

/**
 * Checks an architecture diagram, resolves its stages, and lays out each one. Throws on unknown or duplicate ids,
 * unknown icons and flows, and stage tokens that match nothing, so a broken diagram fails on the dev server.
 */
export function defineArchitecture(definition: ArchitectureDefinition): ArchitectureDiagram {
  const mode = definition.layout ?? "auto"
  const flows = definition.flows ?? {}
  const nodeIds = new Set(Object.keys(definition.nodes))
  const nodes = Object.entries(definition.nodes).map(([id, node]) => checkNode(id, node, nodeIds, mode))
  const edges = (definition.edges ?? []).map((edge) => checkEdge(edge, nodeIds, flows))
  const notes = (definition.notes ?? []).map((note) => checkNote(note, nodeIds))
  const groups = (definition.groups ?? []).map((group) => checkGroup(group, nodeIds))
  const parentOf = checkComposites(nodes)
  const itemIds = [...nodeIds, ...notes.map((note) => note.id), ...groups.map((group) => group.id)]
  const explicitEdgeIds = (definition.edges ?? []).flatMap((edge) => (edge.id === undefined ? [] : [edge.id]))

  checkIds([...itemIds, ...edges.map((edge) => edge.id)], [...itemIds, ...explicitEdgeIds])

  const stages = definition.stages ?? [itemIds]

  if (stages.length === 0) {
    fail("`stages` is empty; omit it to show everything at once")
  }

  for (const edge of edges) {
    if (!Number.isInteger(edge.stage) || edge.stage < 0 || edge.stage >= stages.length) {
      fail(`edge "${edge.id}" has stage ${edge.stage}; there are stages 0 to ${stages.length - 1}`)
    }
  }

  const parts: Parts = {
    canvas: definition.canvas,
    pins: pinPositions(definition, nodes, notes),
    mode,
    direction: definition.direction ?? "right",
    routing: definition.routing ?? "curve",
    nodes,
    edges,
    notes,
    groups,
    flows,
    parentOf,
  }

  return {
    canvas: definition.canvas,
    nodes,
    edges,
    notes,
    groups: [
      ...groups,
      ...nodes
        .filter((node) => node.contains.length > 0)
        .map((node) => ({
          id: node.id,
          label: node.label,
          contains: node.contains,
          composite: true,
        })),
    ],
    ...resolveStages(parts, stages),
  }
}
