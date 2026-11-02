import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import {
  DEFAULT_TIMING,
  type Frame,
  frameAt,
  frameOf,
  type NodeFrame,
  planTransition,
  sceneOfFrame,
  type Timing,
} from "./choreography"
import { pathData, pathLength, type Point, type Rect } from "./geometry"
import { architectureIcons } from "./icons"
import { isIconName } from "./icons/names"
import { type EdgeGeometry, edgeGeometry, GROUP, LABEL, labelSize, stackOffset } from "./layout"
import {
  type ArchitectureDiagram,
  type CompositeClicks,
  clickComposite,
  NODE,
  type NodeView,
  shownStage,
  type StageState,
} from "./model"
import "./Architecture.css"

interface ArchitectureProps {
  readonly diagram: ArchitectureDiagram
  /** The slide's build: shows that stage, and the last one once the builds run past the stages. */
  readonly step?: number
  /** A fixed stage, for showing one state of a diagram on a slide of its own; wins over `step`. */
  readonly stage?: number
  /** Milliseconds for each phase of a stage change: nodes move, new ones appear, new edges draw in. */
  readonly timing?: Partial<Timing>
  readonly className?: string
  /** Accessible name of the drawing. */
  readonly label?: string
  /** Makes every node a button that reports its id; the drawing is then a group rather than an image. */
  readonly onSelectNode?: (id: string) => void
  /** The node drawn as pressed while `onSelectNode` is set. */
  readonly selectedNode?: string
}

const reducedMotion = "(prefers-reduced-motion: reduce)"

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(reducedMotion)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(reducedMotion).matches,
    () => false,
  )
}

/**
 * Plays stage changes: each new stage starts from whatever is on screen, so a key pressed mid-transition turns
 * it around or carries it on without a jump.
 */
function useStageFrame(diagram: ArchitectureDiagram, state: StageState, timing: Timing): Frame {
  const reduceMotion = useReducedMotion()
  const settled = useMemo(() => frameOf(diagram, state), [diagram, state])
  const [frame, setFrame] = useState(settled)
  const current = useRef(settled)
  const shownDiagram = useRef(diagram)

  useEffect(() => {
    const show = (next: Frame): void => {
      current.current = next
      setFrame(next)
    }

    if (reduceMotion || shownDiagram.current !== diagram) {
      shownDiagram.current = diagram
      show(settled)
      return
    }

    const start = current.current
    const plan = planTransition(diagram, sceneOfFrame(start), state, timing)

    if (plan.duration === 0) {
      show(settled)
      return
    }

    const begin = performance.now()
    let handle = 0

    const tick = (now: number): void => {
      const elapsed = now - begin

      if (elapsed >= plan.duration) {
        show(settled)
        return
      }

      show(frameAt(start, state, plan, elapsed))
      handle = requestAnimationFrame(tick)
    }

    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [diagram, state, settled, timing, reduceMotion])

  return frame
}

interface StageItemProps {
  readonly id: string
  readonly state: StageState
  readonly opacity: number
  readonly className: string
  readonly transform?: string
  readonly children: ReactNode
}

/**
 * An element that stages show and hide. Fading runs per frame on the outer group and dimming as a CSS transition
 * on the inner one, so a spotlight never waits on a fade.
 */
function StageItem({ id, state, opacity, className, transform, children }: StageItemProps): React.JSX.Element | null {
  if (opacity <= 0.001) {
    return null
  }

  const isLit = state.spotlight !== undefined && state.lit.has(id)
  const isDim = state.spotlight !== undefined && !isLit

  return (
    <g
      aria-hidden={opacity < 0.5 ? true : undefined}
      className={`arch-item ${className} ${isLit ? "is-lit" : ""}`}
      opacity={opacity >= 0.999 ? undefined : opacity}
      transform={transform}
    >
      <g className={isDim ? "arch-dim is-dim" : "arch-dim"}>{children}</g>
    </g>
  )
}

function TextLines({ text, lineHeight }: {
  readonly text: string
  readonly lineHeight: number
}): React.JSX.Element {
  const lines = text.split("\n")

  return (
    <>
      {lines.map((line, index) => (
        <tspan key={index} x={0} dy={index === 0 ? (-(lines.length - 1) * lineHeight) / 2 : lineHeight}>
          {line}
        </tspan>
      ))}
    </>
  )
}

function NodeIcon({ icon, x, y, size }: {
  readonly icon: ReactNode
  readonly x: number
  readonly y: number
  readonly size: number
}): React.JSX.Element {
  return (
    <svg className="arch-node-icon" x={x} y={y} width={size} height={size} overflow="visible">
      {isIconName(icon) ? architectureIcons[icon] : icon}
    </svg>
  )
}

function NodeContent({ view, rect }: {
  readonly view: NodeView
  readonly rect: Rect
}): React.JSX.Element {
  const { x, y, width, height } = rect
  const centerX = x + width / 2
  const centerY = y + height / 2
  const hasSublabel = view.sublabel !== undefined

  if (view.iconAt === "top") {
    const labelY = y + NODE.padding + NODE.topIcon + 12 + NODE.labelSize / 2

    return (
      <>
        {view.icon === undefined ? null : (
          <NodeIcon icon={view.icon} x={centerX - NODE.topIcon / 2} y={y + NODE.padding} size={NODE.topIcon} />
        )}
        <text className="arch-node-label" x={centerX} y={labelY} textAnchor="middle">
          {view.label}
        </text>
        {hasSublabel ? (
          <text className="arch-node-sublabel" x={centerX} y={labelY + 25} textAnchor="middle">
            {view.sublabel}
          </text>
        ) : null}
      </>
    )
  }

  const hasIcon = view.icon !== undefined
  const textX = hasIcon ? x + NODE.padding + NODE.icon + NODE.iconGap : centerX
  const anchor = hasIcon ? "start" : "middle"

  return (
    <>
      {hasIcon ? (
        <NodeIcon icon={view.icon} x={x + NODE.padding} y={centerY - NODE.icon / 2} size={NODE.icon} />
      ) : null}
      <text className="arch-node-label" x={textX} y={hasSublabel ? centerY - 10 : centerY} textAnchor={anchor}>
        {view.label}
      </text>
      {hasSublabel ? (
        <text className="arch-node-sublabel" x={textX} y={centerY + 15} textAnchor={anchor}>
          {view.sublabel}
        </text>
      ) : null}
    </>
  )
}

const compactCount = new Intl.NumberFormat("en", { notation: "compact" })

/** The "×n" pill on a stack's bottom-right corner, clear of the back cards, which rise up and to the right. */
function Badge({ count, x, y }: {
  readonly count: number
  readonly x: number
  readonly y: number
}): React.JSX.Element {
  const text = `×${compactCount.format(count)}`
  const width = 20 + text.length * 9

  return (
    <g className="arch-badge">
      <rect x={x - width / 2} y={y - 13} width={width} height={26} rx={13} />
      <text x={x} y={y} textAnchor="middle">
        {text}
      </text>
    </g>
  )
}

/** A composite's ⊕ (with how many nodes it holds) or ⊖, drawn round (x, y). */
function CompositeBadge({ open, count, x, y }: {
  readonly open: boolean
  readonly count: number
  readonly x: number
  readonly y: number
}): React.JSX.Element {
  const width = open ? 26 : 46
  const sign = x - width / 2 + 13

  return (
    <g className="arch-composite-badge">
      <rect x={x - width / 2} y={y - 13} width={width} height={26} rx={13} />
      <circle cx={sign} cy={y} r={7.5} />
      <path d={open ? `M${sign - 4} ${y}h8` : `M${sign - 4} ${y}h8M${sign} ${y - 4}v8`} />
      {open ? null : (
        <text x={sign + 18} y={y} textAnchor="middle">
          {count}
        </text>
      )}
    </g>
  )
}

/**
 * Toggles a composite on click, Enter, or Space, without the deck seeing the key or the click. A pointer click
 * gives focus back, so the presenter's next Space advances the slide rather than toggling again.
 */
function CompositeToggle({ id, label, open, onToggle, children }: {
  readonly id: string
  readonly label: string
  readonly open: boolean
  readonly onToggle: (keyboard: boolean) => void
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <g
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
      className="arch-toggle"
      data-composite={id}
      onClick={(event) => {
        event.stopPropagation()

        if (event.detail > 0) {
          event.currentTarget.blur()
        }

        onToggle(event.detail === 0)
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        onToggle(true)
      }}
      role="button"
      tabIndex={0}
    >
      {children}
    </g>
  )
}

/** A node that reports its id on click, Enter, or Space. */
function NodeButton({ id, label, pressed, onSelect, children }: {
  readonly id: string
  readonly label: string
  readonly pressed: boolean
  readonly onSelect: (id: string) => void
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <g
      aria-label={`Inspect ${label}`}
      aria-pressed={pressed}
      className="arch-select"
      data-node={id}
      onClick={() => onSelect(id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return
        }

        event.preventDefault()
        onSelect(id)
      }}
      role="button"
      tabIndex={0}
    >
      {children}
    </g>
  )
}

/**
 * A node drawn round the origin, in unscaled units; its group's transform places and scales it. During a change
 * in place the card stays opaque: back cards fade one by one, and the old content fades out before the new
 * content fades in, so the two never overlap. A stack's back cards are drawn apart, beneath the edges, so an edge
 * reaching the front card over them stays in sight.
 */
function NodeShape({ frame, part, holds }: {
  readonly frame: NodeFrame
  readonly part: "backs" | "front"
  /** How many nodes a composite holds; 0 for a plain node. */
  readonly holds: number
}): React.JSX.Element {
  const [width, height] = frame.size
  const rect: Rect = {
    x: -width / 2,
    y: -height / 2,
    width,
    height,
    radius: NODE.radius,
  }
  const before = frame.previous ?? frame.view
  const mix = frame.previous === undefined ? 1 : frame.mix
  const oldLayers = stackOffset(before.replicas) / NODE.replicaOffset
  const newLayers = stackOffset(frame.view.replicas) / NODE.replicaOffset
  const layers = Math.max(oldLayers, newLayers)
  // Back cards first, furthest first, so the front card covers them.
  const backs = Array.from({ length: layers }, (_, index) => layers - index)
  const contents = [
    {
      view: before,
      opacity: Math.max(0, 1 - mix * 2),
    },
    {
      view: frame.view,
      opacity: Math.max(0, mix * 2 - 1),
    },
  ].filter((content, index) => (index === 1 && frame.previous === undefined) || content.opacity > 0)

  if (part === "backs") {
    return (
      <>
        {backs.map((layer) => {
          const back = {
            ...rect,
            x: rect.x + layer * NODE.replicaOffset,
            y: rect.y - layer * NODE.replicaOffset,
          }
          const opacity = (layer <= oldLayers ? 1 - mix : 0) + (layer <= newLayers ? mix : 0)

          return (
            <g className="arch-node-back" key={layer} opacity={opacity >= 1 ? undefined : opacity}>
              <rect className="arch-node-fill" x={back.x} y={back.y} width={width} height={height} rx={NODE.radius} />
            </g>
          )
        })}
      </>
    )
  }

  return (
    <>
      <rect className="arch-node-fill" x={rect.x} y={rect.y} width={width} height={height} rx={NODE.radius} />
      {contents.map(({ view, opacity }, index) => (
        <g key={index} opacity={opacity >= 1 || frame.previous === undefined ? undefined : opacity}>
          <NodeContent rect={rect} view={view} />
          {(view.replicas ?? 1) < 2 ? null : (
            <Badge count={view.replicas ?? 1} x={rect.x + width} y={rect.y + height} />
          )}
        </g>
      ))}
      {holds === 0 ? null : <CompositeBadge count={holds} open={false} x={rect.x + width - 8} y={rect.y} />}
    </>
  )
}

/**
 * An edge label on a knockout in the slide's background: a box under the lines, so the edge can't show between
 * them, and a stroke round the glyphs. The box is narrower than the layout's estimate, which errs wide.
 */
function LabelText({ text, color }: {
  readonly text: string
  readonly color: string | undefined
}): React.JSX.Element {
  const [width, height] = labelSize(text)
  const boxWidth = width * 0.82
  const boxHeight = height - 10

  return (
    <g data-color={color}>
      <rect className="arch-label-box" x={-boxWidth / 2} y={-boxHeight / 2} width={boxWidth} height={boxHeight} rx={6} />
      <text textAnchor="middle">
        <TextLines lineHeight={LABEL.lineHeight} text={text} />
      </text>
    </g>
  )
}

function headPath([left, tip, right]: readonly [Point, Point, Point]): string {
  return `M${left.join(" ")}L${tip.join(" ")}L${right.join(" ")}Z`
}

/** Dots running along a spotlit edge, both ways on a two-headed one. */
function Packets({ geometry, color, both }: {
  readonly geometry: EdgeGeometry
  readonly color: string | undefined
  readonly both: boolean
}): React.JSX.Element {
  const duration = Math.max(1.2, pathLength(geometry.path) / 260)
  const path = pathData(geometry.path)
  const runs = both ? [false, true] : [false]

  return (
    <g data-color={color}>
      {runs.flatMap((reverse) =>
        [0, 0.5].map((phase) => (
          <circle className="arch-packet" key={`${reverse}-${phase}`} r={5.5}>
            <animateMotion
              begin={`${-(phase + (reverse ? 0.25 : 0)) * duration}s`}
              calcMode="linear"
              dur={`${duration}s`}
              keyPoints={reverse ? "1;0" : "0;1"}
              keyTimes="0;1"
              path={path}
              repeatCount="indefinite"
            />
          </circle>
        )),
      )}
    </g>
  )
}

function frameRect(frame: NodeFrame | undefined): Rect | undefined {
  if (frame === undefined) {
    return undefined
  }

  const width = frame.size[0] * frame.scale
  const height = frame.size[1] * frame.scale

  return {
    x: frame.center[0] - width / 2,
    y: frame.center[1] - height / 2,
    width,
    height,
    radius: NODE.radius * frame.scale,
  }
}

function place([x, y]: Point, scale: number): string {
  return `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale.toFixed(4)})`
}

/**
 * An architecture diagram that builds up stage by stage. Between stages, nodes first move to their new places,
 * then new nodes appear, then new edges draw in; leaving elements go first, in the reverse order.
 */
export function Architecture({
  diagram,
  step,
  stage,
  timing,
  className = "",
  label = "Architecture diagram",
  onSelectNode,
  selectedNode,
}: ArchitectureProps): React.JSX.Element {
  const { move = DEFAULT_TIMING.move, appear = DEFAULT_TIMING.appear, draw = DEFAULT_TIMING.draw } = timing ?? {}
  const phases = useMemo(
    () => ({
      move,
      appear,
      draw,
    }),
    [move, appear, draw],
  )

  const lastStage = diagram.stages.length - 1
  const index = Math.min(Math.max(stage ?? step ?? 0, 0), lastStage)
  // Clicks hold through every build; the deck mounts each slide afresh, which clears them.
  const [clicked, setClicked] = useState<{
    readonly diagram: ArchitectureDiagram
    readonly clicks: CompositeClicks
  }>()
  const clicks = clicked?.diagram === diagram ? clicked.clicks : new Map<string, boolean>()
  const state = shownStage(diagram, index, clicks)
  const svg = useRef<SVGSVGElement>(null)
  const refocus = useRef<string>(undefined)
  const toggle = (id: string, keyboard: boolean): void => {
    refocus.current = keyboard ? id : undefined
    setClicked({
      diagram,
      clicks: clickComposite(clicks, state, id),
    })
  }

  const frame = useStageFrame(diagram, state, phases)

  // A box and its group are different elements, so focus drops when one leaves; hand it to the other once drawn.
  useEffect(() => {
    const id = refocus.current

    if (id === undefined || document.activeElement !== document.body) {
      return
    }

    const next = svg.current?.querySelector<SVGGElement>(`[data-composite="${id}"]`)

    if (next) {
      next.focus()
      refocus.current = undefined
    }
  })
  const { spotlight } = state
  const focusId = spotlight?.kind === "focus" ? spotlight.id : undefined
  const shownLabels = diagram.nodes
    .filter((node) => state.visible.has(node.id))
    .map((node) => state.nodes.get(node.id)?.label ?? node.label)
  const description = [
    `Shows ${shownLabels.join(", ")}.`,
    spotlight?.kind === "flow" ? `Highlights the ${spotlight.label} flow.` : "",
    focusId === undefined ? "" : `Focuses on ${state.nodes.get(focusId)?.label}.`,
  ].join(" ")

  const edges = diagram.edges.flatMap((edge) => {
    const edgeFrame = frame.edges.get(edge.id)
    const fromRect = frameRect(frame.nodes.get(edgeFrame?.from ?? edge.from))
    const toRect = frameRect(frame.nodes.get(edgeFrame?.to ?? edge.to))

    if (edgeFrame === undefined || fromRect === undefined || toRect === undefined) {
      return []
    }

    if (edgeFrame.draw <= 0.001 && edgeFrame.label <= 0.001) {
      return []
    }

    return [
      {
        edge,
        frame: edgeFrame,
        geometry: edgeGeometry(edge, edgeFrame.route, fromRect, toRect),
      },
    ]
  })

  const nodeLayer = (part: "backs" | "front"): ReactNode =>
    diagram.nodes.map((node) => {
      const nodeFrame = frame.nodes.get(node.id)
      const stacked = Math.max(nodeFrame?.view.replicas ?? 1, nodeFrame?.previous?.replicas ?? 1) > 1

      if (nodeFrame === undefined || (part === "backs" && !stacked)) {
        return null
      }

      const tone = nodeFrame.view.tone === undefined ? "" : `is-${nodeFrame.view.tone}`
      const holds = part === "front" ? node.contains.length : 0
      const shape = <NodeShape frame={nodeFrame} holds={holds} part={part} />

      return (
        <StageItem
          className={`arch-node ${tone} ${node.id === focusId ? "is-focus" : ""}`}
          id={node.id}
          key={node.id}
          opacity={nodeFrame.opacity}
          state={state}
          transform={place(nodeFrame.center, nodeFrame.scale)}
        >
          {holds === 0 && onSelectNode !== undefined && part === "front" ? (
            <NodeButton
              id={node.id}
              label={nodeFrame.view.label}
              onSelect={onSelectNode}
              pressed={node.id === selectedNode}
            >
              {shape}
            </NodeButton>
          ) : holds === 0 ? (
            shape
          ) : (
            <CompositeToggle
              id={node.id}
              label={nodeFrame.view.label}
              onToggle={(keyboard) => toggle(node.id, keyboard)}
              open={false}
            >
              {shape}
            </CompositeToggle>
          )}
        </StageItem>
      )
    })

  return (
    <svg
      aria-label={label}
      className={`architecture ${className}`}
      ref={svg}
      data-spotlight={spotlight?.kind}
      data-variant="clean"
      role={onSelectNode === undefined ? "img" : "group"}
      viewBox={`0 0 ${diagram.canvas.width} ${diagram.canvas.height}`}
    >
      <desc>{description}</desc>
      <g className="arch-groups">
        {diagram.groups.map((group) => {
          const groupFrame = frame.groups.get(group.id)

          if (groupFrame === undefined) {
            return null
          }

          const { rect, scale } = groupFrame
          const title = group.composite ? (state.nodes.get(group.id)?.label ?? group.label) : group.label
          const box = (
            <>
              <rect
                className="arch-group-box"
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                rx={rect.radius}
              />
              <text className="arch-group-label" transform={place([rect.x + 20 * scale, rect.y + 26 * scale], scale)}>
                {title}
              </text>
              {group.composite ? (
                <g transform={place([rect.x + rect.width - 26 * scale, rect.y + 21 * scale], scale)}>
                  <CompositeBadge count={group.contains.length} open x={0} y={0} />
                </g>
              ) : null}
            </>
          )

          return (
            <StageItem
              className={group.composite ? "arch-group is-composite" : "arch-group"}
              id={group.id}
              key={`group-${group.id}`}
              opacity={groupFrame.opacity}
              state={state}
            >
              {group.composite ? (
                <CompositeToggle
                  id={group.id}
                  label={title}
                  onToggle={(keyboard) => toggle(group.id, keyboard)}
                  open
                >
                  {box}
                  <rect
                    className="arch-toggle-hit"
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={(GROUP.padding + GROUP.labelSpace) * scale}
                  />
                </CompositeToggle>
              ) : (
                box
              )}
            </StageItem>
          )
        })}
      </g>
      <g className="arch-node-backs">{nodeLayer("backs")}</g>
      <g className="arch-edges">
        {edges.map(({ edge, frame: edgeFrame, geometry }) => (
          <StageItem className="arch-edge" id={edge.id} key={edge.id} opacity={1} state={state}>
            <g data-color={edge.color}>
              <path
                className="arch-edge-line"
                d={pathData(geometry.line)}
                pathLength={1}
                strokeDashoffset={1 - edgeFrame.draw}
              />
              {geometry.heads.map((head, headIndex) => (
                <path
                  className="arch-edge-head"
                  d={headPath(head)}
                  key={headIndex}
                  opacity={Math.min(Math.max((edgeFrame.draw - 0.88) / 0.12, 0), 1)}
                />
              ))}
            </g>
          </StageItem>
        ))}
      </g>
      {spotlight === undefined ? null : (
        <g aria-hidden="true" className="arch-packets">
          {edges
            .filter(({ edge }) => state.lit.has(edge.id))
            .map(({ edge, geometry }) => (
              <Packets both={edge.both} color={edge.color} geometry={geometry} key={`${index}-${edge.id}`} />
            ))}
        </g>
      )}
      <g className="arch-nodes">{nodeLayer("front")}</g>
      <g className="arch-notes">
        {diagram.notes.map((note) => {
          const noteFrame = frame.notes.get(note.id)

          if (noteFrame === undefined) {
            return null
          }

          return (
            <StageItem
              className="arch-note"
              id={note.id}
              key={note.id}
              opacity={noteFrame.opacity}
              state={state}
              transform={place(noteFrame.center, noteFrame.scale)}
            >
              <text textAnchor="middle">
                <TextLines lineHeight={25} text={note.text} />
              </text>
            </StageItem>
          )
        })}
      </g>
      <g className="arch-labels">
        {edges.map(({ edge, frame: edgeFrame, geometry }) =>
          edge.label === undefined ? null : (
            <StageItem
              className="arch-edge-label"
              id={edge.id}
              key={edge.id}
              opacity={edgeFrame.label}
              state={state}
              transform={place(geometry.labelPoint, frame.scale)}
            >
              <LabelText color={edge.color} text={edge.label} />
            </StageItem>
          ),
        )}
      </g>
    </svg>
  )
}
