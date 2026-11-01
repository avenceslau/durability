import { lockScroll, unlockScroll } from '@cloudflare/nimbus-docs/client';
import {
  sourceUrl,
  type ArchitectureScenario,
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
  const stepsList = query<HTMLOListElement>('[data-step-list]');
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

  const currentScenario = () => model.scenarios[scenarioIndex]!;
  const currentStep = () => currentScenario().steps[stepIndex]!;
  const text = (selector: string, value: string) => {
    query(selector).textContent = value;
  };

  function inspect(nodeId: string) {
    const node = model.nodes.find((entry) => entry.id === nodeId)!;
    text('[data-node-title]', node.title);
    text('[data-node-description]', node.description);
    query<HTMLAnchorElement>('[data-node-link]').href = node.href;
    root
      .querySelectorAll<HTMLButtonElement>('[data-node]')
      .forEach((button) => {
        button.setAttribute(
          'aria-pressed',
          String(button.dataset.node === nodeId)
        );
      });
  }

  function renderSteps(scenario: ArchitectureScenario) {
    const items = scenario.steps.map((step, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.step = String(index);
      const number = document.createElement('span');
      number.textContent = String(index + 1);
      button.append(number, document.createTextNode(step.title));
      item.append(button);
      return item;
    });
    stepsList.replaceChildren(...items);
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
    text('[data-scenario-description]', scenario.description);
    text(
      '[data-step-title]',
      `${stepIndex + 1}/${scenario.steps.length} · ${step.title}`
    );
    text('[data-step-description]', step.description);
    text('[data-durable]', step.durable);
    text('[data-volatile]', step.volatile);
    query('[data-status]').setAttribute('data-status', step.status);
    stepsList
      .querySelectorAll<HTMLButtonElement>('[data-step]')
      .forEach((button, index) => {
        if (index === stepIndex) {
          button.setAttribute('aria-current', 'step');
        } else {
          button.removeAttribute('aria-current');
        }
      });
    root.querySelectorAll<HTMLElement>('[data-node]').forEach((node) => {
      node.dataset.active = String(step.nodes.includes(node.dataset.node!));
    });
    root.querySelectorAll<SVGElement>('[data-edge]').forEach((edge) => {
      const active = step.edges.includes(edge.dataset.edge!);
      edge.dataset.active = String(active);
      edge
        .querySelector('path')
        ?.setAttribute(
          'marker-end',
          `url(#${root.dataset.arrowMarker}-${active ? 'active' : 'muted'})`
        );
    });
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
    inspect(step.nodes[0]!);
  }

  function goTo(scenario: number, step: number, scrollCode = true) {
    if (scenario !== scenarioIndex) {
      scenarioIndex = scenario;
      renderSteps(currentScenario());
    }
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
    predicate: (step: ArchitectureStep) => boolean
  ): [number, number] | undefined {
    if (predicate(currentStep())) {
      return [scenarioIndex, stepIndex];
    }
    const local = currentScenario().steps.findIndex(predicate);
    if (local >= 0) {
      return [scenarioIndex, local];
    }
    for (const [index, scenario] of model.scenarios.entries()) {
      const step = scenario.steps.findIndex(predicate);
      if (step >= 0) {
        return [index, step];
      }
    }
    return undefined;
  }

  root.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const step = event.target.closest<HTMLButtonElement>('[data-step]');
      const node = event.target.closest<HTMLButtonElement>('[data-node]');
      const line = event.target.closest<HTMLElement>('[data-linked-line]');
      if (step) {
        goTo(scenarioIndex, Number(step.dataset.step));
      } else if (node) {
        const source = model.nodes.find(
          (entry) => entry.id === node.dataset.node
        )!.source;
        const destination =
          (source &&
            findStep(
              (entry) =>
                entry.source.excerpt === source &&
                entry.nodes.includes(node.dataset.node!)
            )) ||
          findStep((entry) => entry.nodes.includes(node.dataset.node!));
        if (destination) {
          goTo(...destination);
        }
        inspect(node.dataset.node!);
      } else if (line) {
        const file =
          line.closest<HTMLElement>('[data-file-panel]')!.dataset.file;
        const number = Number(line.dataset.sourceLine);
        const destination = findStep(
          (entry) =>
            model.excerpts.find(
              (excerpt) => excerpt.id === entry.source.excerpt
            )!.file === file &&
            number >= entry.source.from &&
            number <= entry.source.to
        );
        if (destination) {
          goTo(...destination, false);
        }
      }
    },
    { signal }
  );

  root.addEventListener(
    'keydown',
    (event) => {
      if (
        !(event instanceof KeyboardEvent) ||
        !(event.target instanceof HTMLElement)
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
        event.target.isContentEditable ||
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
  query('[data-reset]').addEventListener(
    'click',
    () => goTo(scenarioIndex, 0),
    { signal }
  );
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
  return () => {
    if (dialog.open) {
      dialog.close();
    }
    releaseScroll();
    controller.abort();
  };
}
