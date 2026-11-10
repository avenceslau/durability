import { lockScroll, unlockScroll } from '@cloudflare/nimbus-docs/client';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Architecture } from '../../kit/architecture/Architecture.tsx';
import { pointOnPath } from '../../kit/architecture/geometry';
import {
  edgeGeometry,
  labelSize,
  nodeRect,
} from '../../kit/architecture/layout';
import type { ArchitectureDiagram } from '../../kit/architecture/model';
import {
  introducedNodes,
  previewDiagram,
  scenarioDiagram,
  sourceUrl,
  stepNodes,
  type ArchitectureStep,
  type WalkthroughState,
} from '../../lib/architecture';

export function mountWalkthrough(element: Element): () => void {
  if (!(element instanceof HTMLElement)) {
    return () => {};
  }
  const root = element;
  const model = JSON.parse(root.dataset.model!) as WalkthroughState;
  const controller = new AbortController();
  const { signal } = controller;
  let scenarioIndex = 0;
  let stepIndex = 0;
  const query = <T extends Element = HTMLElement>(selector: string) =>
    root.querySelector<T>(selector)!;
  const scenarioSelect = query<HTMLSelectElement>('[data-scenario]');
  const sourceSelect = query<HTMLSelectElement>('[data-source-select]');
  const previous = query<HTMLButtonElement>('[data-previous]');
  const next = query<HTMLButtonElement>('[data-next]');
  const dialog = query<HTMLDialogElement>('[data-dialog]');
  const openButton = query<HTMLButtonElement>('[data-open]');
  let scrollLocked = false;
  const releaseScroll = () => {
    if (scrollLocked) {
      unlockScroll();
      scrollLocked = false;
    }
  };

  const graph = createRoot(query('[data-graph]'));
  // Laying out a scenario's stages takes a moment, so do it once, when first shown.
  const diagrams = new Map<number, ArchitectureDiagram>();
  let selectedNode: string | undefined;

  const currentScenario = () => model.scenarios[scenarioIndex]!;
  const currentStep = () => currentScenario().steps[stepIndex]!;
  const diagramOf = (index: number) => {
    let diagram = diagrams.get(index);
    if (!diagram) {
      diagram = scenarioDiagram(model, model.scenarios[index]!);
      diagrams.set(index, diagram);
    }
    return diagram;
  };
  const nodesOf = (scenario: number, step: number) =>
    stepNodes(
      diagramOf(scenario),
      step,
      introducedNodes(model, model.scenarios[scenario]!.steps[step]!)
    );

  function draw() {
    graph.render(
      createElement(Architecture, {
        diagram: diagramOf(scenarioIndex),
        stage: stepIndex,
        label: model.title,
        onSelectNode: selectNode,
        selectedNode,
      })
    );
  }
  const text = (selector: string, value: string) => {
    query(selector).textContent = value;
  };

  const column = query('.aw-diagram-column');
  const card = query('[data-step-card]');

  /**
   * Places the step card beside the node the step is about, on the side that
   * covers the fewest spotlit nodes. Narrow screens keep the card in flow.
   */
  function placeCard() {
    const svg = column.querySelector('[data-graph] svg');
    if (!svg || getComputedStyle(card).position !== 'absolute') {
      return;
    }

    const diagram = diagramOf(scenarioIndex);
    const state = diagram.stages[stepIndex]!;
    const anchor = nodesOf(scenarioIndex, stepIndex)[0]!;
    const canvas = model.diagram.canvas;
    const bounds = column.getBoundingClientRect();
    const drawing = svg.getBoundingClientRect();
    const scale = Math.min(
      drawing.width / canvas.width,
      drawing.height / canvas.height
    );
    const originX =
      drawing.left - bounds.left + (drawing.width - canvas.width * scale) / 2;
    const originY =
      drawing.top - bounds.top + (drawing.height - canvas.height * scale) / 2;
    const toScreen = (rect: Box): Box => ({
      x: originX + rect.x * scale,
      y: originY + rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    });
    const canvasRect = (id: string) =>
      nodeRect(
        state.nodes.get(id)!,
        state.layout.nodes.get(id)!,
        state.layout.scale
      );
    const onScreen = (id: string) => toScreen(canvasRect(id));

    const target = onScreen(anchor);
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    // Centred on the node, or flush with one of its ends, on each side.
    const across = [
      target.x + target.width / 2 - width / 2,
      target.x,
      target.x + target.width - width,
    ];
    const along = [
      target.y + target.height / 2 - height / 2,
      target.y,
      target.y + target.height - height,
    ];
    const candidates = [
      ...across.map((x) => ({
        side: 'above',
        x,
        y: target.y - cardGap - height,
      })),
      ...across.map((x) => ({
        side: 'below',
        x,
        y: target.y + target.height + cardGap,
      })),
      ...along.map((y) => ({
        side: 'right',
        x: target.x + target.width + cardGap,
        y,
      })),
      ...along.map((y) => ({ side: 'left', x: target.x - cardGap - width, y })),
    ].map((candidate) => ({
      ...candidate,
      x: clamp(candidate.x, cardMargin, bounds.width - width - cardMargin),
      y: clamp(candidate.y, cardMargin, bounds.height - height - cardMargin),
    }));

    // Covering the step's own node is worst, then what it spotlights: nodes,
    // edges, and edge labels.
    const shown = [...state.layout.nodes.keys()].filter((id) =>
      state.visible.has(id)
    );
    const obstacles = shown.map((id) => ({
      rect: onScreen(id),
      weight: id === anchor ? 100 : state.lit.has(id) ? 10 : 1,
    }));
    for (const edge of diagram.edges) {
      const route = state.layout.edges.get(edge.id);
      if (!state.visible.has(edge.id) || !route) {
        continue;
      }
      const [from, to] = state.ends.get(edge.id) ?? [edge.from, edge.to];
      const geometry = edgeGeometry(
        edge,
        route,
        canvasRect(from),
        canvasRect(to)
      );
      const weight = state.lit.has(edge.id) ? 10 : 1;
      for (let index = 0; index <= edgeSamples; index += 1) {
        const [x, y] = pointOnPath(geometry.path, index / edgeSamples);
        obstacles.push({
          rect: toScreen({ x: x - 4, y: y - 4, width: 8, height: 8 }),
          weight,
        });
      }
      if (edge.label !== undefined) {
        const [labelWidth, labelHeight] = labelSize(edge.label).map(
          (size) => size * state.layout.scale
        ) as [number, number];
        const [x, y] = geometry.labelPoint;
        obstacles.push({
          rect: toScreen({
            x: x - labelWidth / 2,
            y: y - labelHeight / 2,
            width: labelWidth,
            height: labelHeight,
          }),
          weight,
        });
      }
    }
    const cost = (position: { x: number; y: number }) =>
      obstacles.reduce(
        (sum, { rect, weight }) =>
          sum + overlap({ ...position, width, height }, rect) * weight,
        0
      );
    const best = candidates.reduce((chosen, candidate) =>
      cost(candidate) < cost(chosen) ? candidate : chosen
    );

    const pointsAcross = best.side === 'above' || best.side === 'below';
    const caret = pointsAcross
      ? target.x + target.width / 2 - best.x
      : target.y + target.height / 2 - best.y;
    card.dataset.side = best.side;
    card.style.left = `${best.x}px`;
    card.style.top = `${best.y}px`;
    card.style.setProperty(
      '--aw-caret',
      `${clamp(caret, cardMargin, (pointsAcross ? width : height) - cardMargin)}px`
    );
  }

  function render(scrollCode = false) {
    const scenario = currentScenario();
    const step = currentStep();
    const excerpt = model.excerpts.find(
      (entry) => entry.id === step.source.excerpt
    )!;
    scenarioSelect.value = scenario.id;
    sourceSelect.value = excerpt.file;
    previous.disabled = stepIndex === 0;
    next.disabled = stepIndex === scenario.steps.length - 1;
    root.dataset.activeScenario = scenario.id;
    root.dataset.activeStep = step.id;
    text(
      '[data-step-title]',
      `${stepIndex + 1}/${scenario.steps.length} · ${step.title}`
    );
    text('[data-step-description]', step.description);
    text('[data-durable]', step.durable);
    text('[data-volatile]', step.volatile);
    query('[data-status]').setAttribute('data-status', step.status);
    text('[data-source-file]', excerpt.file);
    query<HTMLAnchorElement>('[data-source-link]').href = sourceUrl(
      excerpt.file,
      step.source.from,
      step.source.to
    );
    root.querySelectorAll<HTMLElement>('[data-file-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.file !== excerpt.file;
      panel
        .querySelectorAll<HTMLElement>('[data-source-line]')
        .forEach((line) => {
          const number = Number(line.dataset.sourceLine);
          line.toggleAttribute(
            'data-highlighted',
            !panel.hidden &&
              number >= step.source.from &&
              number <= step.source.to
          );
        });
      if (!panel.hidden && scrollCode) {
        const line = panel.querySelector<HTMLElement>('[data-highlighted]');
        const pre = panel.querySelector('pre');
        if (line && pre && pre.clientHeight > 0) {
          // Scroll only the code pane, not the entire page or focused control.
          const offset =
            line.getBoundingClientRect().top -
            pre.getBoundingClientRect().top +
            pre.scrollTop;
          pre.scrollTop = Math.max(0, offset - pre.clientHeight / 3);
        }
      }
    });
    selectedNode = nodesOf(scenarioIndex, stepIndex)[0]!;
    draw();
    placeCard();
  }

  function goTo(scenario: number, step: number, scrollCode = true) {
    scenarioIndex = scenario;
    stepIndex = step;
    render(scrollCode);
  }

  function moveStep(direction: number) {
    const index = stepIndex + direction;
    if (index < 0 || index >= currentScenario().steps.length) {
      return;
    }
    const focused = document.activeElement;
    goTo(scenarioIndex, index);
    // File changes can hide a focused source line; boundary buttons can also
    // become disabled. Keep focus in the explorer so the next arrow still works.
    if (
      focused instanceof HTMLElement &&
      dialog.contains(focused) &&
      (focused.getClientRects().length === 0 || focused.matches(':disabled'))
    ) {
      query<HTMLButtonElement>('[data-close]').focus({ preventScroll: true });
    }
  }

  function findStep(
    predicate: (
      step: ArchitectureStep,
      scenario: number,
      index: number
    ) => boolean
  ): [number, number] | undefined {
    if (predicate(currentStep(), scenarioIndex, stepIndex)) {
      return [scenarioIndex, stepIndex];
    }
    const local = currentScenario().steps.findIndex((step, index) =>
      predicate(step, scenarioIndex, index)
    );
    if (local >= 0) {
      return [scenarioIndex, local];
    }
    for (const [index, scenario] of model.scenarios.entries()) {
      const step = scenario.steps.findIndex((entry, stepAt) =>
        predicate(entry, index, stepAt)
      );
      if (step >= 0) {
        return [index, step];
      }
    }
    return undefined;
  }

  function selectNode(nodeId: string) {
    const source = model.details[nodeId]!.source;
    const shows = (scenario: number, step: number) =>
      nodesOf(scenario, step).includes(nodeId);
    const destination =
      (source &&
        findStep(
          (entry, scenario, step) =>
            entry.source.excerpt === source && shows(scenario, step)
        )) ||
      findStep((_entry, scenario, step) => shows(scenario, step));
    if (destination) {
      goTo(...destination);
    }
    selectedNode = nodeId;
    draw();
  }

  root.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const line = event.target.closest<HTMLElement>('[data-linked-line]');
      if (!line) {
        return;
      }
      const file = line.closest<HTMLElement>('[data-file-panel]')!.dataset.file;
      const number = Number(line.dataset.sourceLine);
      const destination = findStep(
        (entry) =>
          model.excerpts.find((excerpt) => excerpt.id === entry.source.excerpt)!
            .file === file &&
          number >= entry.source.from &&
          number <= entry.source.to
      );
      if (destination) {
        goTo(...destination, false);
      }
    },
    { signal }
  );

  root.addEventListener(
    'keydown',
    (event) => {
      if (
        !(event instanceof KeyboardEvent) ||
        !(event.target instanceof Element)
      ) {
        return;
      }
      const line = event.target.closest<HTMLElement>('[data-linked-line]');
      if (line && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        line.click();
        return;
      }
      if (
        !dialog.open ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.target instanceof HTMLElement &&
          event.target.isContentEditable) ||
        event.target.closest('input, textarea, select') ||
        (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
      ) {
        return;
      }
      const selection = window.getSelection();
      if (
        selection &&
        !selection.isCollapsed &&
        selection.anchorNode &&
        query('.aw-source-column').contains(selection.anchorNode)
      ) {
        return;
      }
      event.preventDefault();
      moveStep(event.key === 'ArrowRight' ? 1 : -1);
    },
    { signal }
  );
  scenarioSelect.addEventListener(
    'change',
    () => {
      const index = model.scenarios.findIndex(
        (entry) => entry.id === scenarioSelect.value
      );
      goTo(index, 0);
    },
    { signal }
  );
  sourceSelect.addEventListener(
    'change',
    () => {
      const destination = findStep(
        (entry) =>
          model.excerpts.find((excerpt) => excerpt.id === entry.source.excerpt)!
            .file === sourceSelect.value
      );
      if (destination) {
        goTo(...destination);
      }
    },
    { signal }
  );
  previous.addEventListener('click', () => moveStep(-1), { signal });
  next.addEventListener('click', () => moveStep(1), { signal });
  openButton.addEventListener(
    'click',
    () => {
      if (dialog.open) {
        return;
      }
      dialog.showModal();
      lockScroll();
      scrollLocked = true;
      openButton.setAttribute('aria-expanded', 'true');
      render(true);
    },
    { signal }
  );
  query('[data-close]').addEventListener('click', () => dialog.close(), {
    signal,
  });
  dialog.addEventListener(
    'close',
    () => {
      releaseScroll();
      openButton.setAttribute('aria-expanded', 'false');
      if (openButton.isConnected) {
        openButton.focus({ preventScroll: true });
      }
    },
    { signal }
  );
  render();
  const resize = new ResizeObserver(() => placeCard());
  resize.observe(column);
  const stopPreview = animatePreview(
    query('.aw-preview-graph'),
    model,
    () => dialog.open
  );
  return () => {
    if (dialog.open) {
      dialog.close();
    }
    releaseScroll();
    controller.abort();
    graph.unmount();
    resize.disconnect();
    stopPreview();
  };
}

const previewStageMs = 3500;
const cardGap = 14;
const edgeSamples = 24;
const cardMargin = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** A rectangle in screen pixels, relative to the diagram column. */
type Box = { x: number; y: number; width: number; height: number };

function overlap(a: Box, b: Box): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Cycles the preview through its flows while it is on screen. Under reduced
 * motion it keeps the static drawing rendered at build time.
 */
function animatePreview(
  container: HTMLElement,
  model: WalkthroughState,
  paused: () => boolean
): () => void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return () => {};
  }
  const diagram = previewDiagram(model);
  if (diagram.stages.length < 2) {
    return () => {};
  }

  const preview = createRoot(container);
  let stage = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const draw = () =>
    preview.render(
      createElement(Architecture, { diagram, stage, label: model.title })
    );
  const advance = () => {
    if (paused()) {
      return;
    }
    stage = (stage + 1) % diagram.stages.length;
    draw();
  };

  draw();
  const observer = new IntersectionObserver(([entry]) => {
    clearInterval(timer);
    timer = entry?.isIntersecting
      ? setInterval(advance, previewStageMs)
      : undefined;
  });
  observer.observe(container);

  return () => {
    observer.disconnect();
    clearInterval(timer);
    preview.unmount();
  };
}
