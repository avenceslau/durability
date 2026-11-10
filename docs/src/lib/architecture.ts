import {
  defineArchitecture,
  type ArchitectureDefinition,
  type ArchitectureDiagram,
  type StageToken,
} from '../kit/architecture/model.ts';

/** What the explorer shows for a diagram node when it is selected. */
export type NodeDetail = {
  description: string;
  href: string;
  /** The excerpt to jump to when the node is selected. */
  source?: string;
};

export type SourceExcerpt = {
  id: string;
  title: string;
  file: string;
  code: string;
  source: string;
  startLine: number;
};

export type ArchitectureStep = {
  id: string;
  title: string;
  description: string;
  /**
   * `focus:<node>` or `flow:<name>` spotlights what the step is about. `id` or
   * `+id` marks a node the step introduces: the card points at it, and it is
   * focused when the step has no spotlight. Every step shows the whole diagram.
   */
  stage: StageToken[];
  source: { excerpt: string; from: number; to: number };
  durable: string;
  volatile: string;
  status: 'normal' | 'commit' | 'failure' | 'recovery' | 'gap';
};

export type ArchitectureScenario = {
  id: string;
  title: string;
  description: string;
  steps: ArchitectureStep[];
};

export type ArchitectureWalkthrough = {
  id: string;
  title: string;
  summary: string;
  /** The whole system; each scenario adds its steps as the diagram's stages. */
  diagram: Omit<ArchitectureDefinition, 'stages'>;
  details: Record<string, NodeDetail>;
  excerpts: SourceExcerpt[];
  scenarios: ArchitectureScenario[];
};

export type WalkthroughState = Omit<ArchitectureWalkthrough, 'excerpts'> & {
  excerpts: Omit<SourceExcerpt, 'code' | 'source'>[];
};

/** Extract real source at build time. Missing/ambiguous anchors fail the build. */
export function sourceExcerpt(
  source: string,
  file: string,
  id: string,
  title: string,
  start: string,
  end: string
): SourceExcerpt {
  const offset = source.indexOf(start);
  if (offset < 0 || source.indexOf(start, offset + start.length) >= 0) {
    throw new Error(`${file}: source anchor must occur exactly once: ${start}`);
  }
  let endOffset = source.indexOf(end, offset + start.length);
  // End markers represent complete source lines, not an inner brace whose
  // indentation happens to contain the requested suffix.
  while (endOffset >= 0) {
    const after = source[endOffset + end.length];
    if (
      (endOffset === 0 || source[endOffset - 1] === '\n') &&
      (after === undefined || after === '\n' || after === '\r')
    ) {
      break;
    }
    endOffset = source.indexOf(end, endOffset + 1);
  }
  if (endOffset < 0) {
    throw new Error(`${file}: missing complete ending source anchor: ${end}`);
  }
  const lineOffset = source.lastIndexOf('\n', offset) + 1;
  const raw = source.slice(lineOffset, endOffset + end.length);
  return {
    id,
    title,
    file,
    code: raw,
    source,
    startLine: source.slice(0, lineOffset).split('\n').length,
  };
}

/** Bind a step to actual source lines rather than maintained line numbers. */
export function sourceFocus(
  excerpt: SourceExcerpt,
  start: string,
  end = start
): ArchitectureStep['source'] {
  const fromOffset = excerpt.code.indexOf(start);
  if (
    fromOffset < 0 ||
    excerpt.code.indexOf(start, fromOffset + start.length) >= 0
  ) {
    throw new Error(
      `${excerpt.file}: focus anchor must occur exactly once: ${start}`
    );
  }
  const toOffset = excerpt.code.indexOf(end, fromOffset);
  if (toOffset < 0) {
    throw new Error(`${excerpt.file}: missing focus ending: ${end}`);
  }
  return {
    excerpt: excerpt.id,
    from:
      excerpt.startLine +
      excerpt.code.slice(0, fromOffset).split('\n').length -
      1,
    to:
      excerpt.startLine +
      excerpt.code.slice(0, toOffset + end.length).split('\n').length -
      1,
  };
}

/** The nodes a step introduces (`id` or `+id` tokens), in the order written. */
export function introducedNodes(
  model: Pick<WalkthroughState, 'diagram'>,
  step: ArchitectureStep
): string[] {
  return step.stage
    .filter((token): token is string => typeof token === 'string')
    .map((token) => token.replace(/^\+/u, ''))
    .filter((id) => id in model.diagram.nodes);
}

/**
 * The diagram a scenario steps through: one stage per step, each showing the
 * whole system with only the step's spotlight lit and everything else dimmed.
 */
export function scenarioDiagram(
  model: Pick<WalkthroughState, 'diagram'>,
  scenario: ArchitectureScenario
): ArchitectureDiagram {
  return defineArchitecture({
    ...model.diagram,
    stages: scenario.steps.map((step, index) => {
      const spotlight = step.stage.find(
        (token) =>
          typeof token === 'string' &&
          (token.startsWith('focus:') || token.startsWith('flow:'))
      );
      const focus =
        spotlight ?? introducedNodes(model, step).map((id) => `focus:${id}`)[0];
      return [...(index === 0 ? ['*'] : []), ...(focus ? [focus] : [])];
    }),
  });
}

/** The whole system at once, for the preview. */
export function overviewDiagram(
  model: Pick<WalkthroughState, 'diagram'>
): ArchitectureDiagram {
  return defineArchitecture(model.diagram);
}

/**
 * The preview's loop: the whole system, then each flow with edges spotlit in
 * turn.
 */
export function previewDiagram(
  model: Pick<WalkthroughState, 'diagram'>
): ArchitectureDiagram {
  const flows = Object.keys(model.diagram.flows ?? {}).filter((flow) =>
    model.diagram.edges?.some((edge) => edge.flow === flow)
  );
  return defineArchitecture({
    ...model.diagram,
    stages: [['*'], ...flows.map((flow) => [`flow:${flow}`])],
  });
}

/**
 * The nodes a step is about: the ones its spotlight lights (a focused node,
 * or the nodes the step introduces, first), else every node.
 */
export function stepNodes(
  diagram: ArchitectureDiagram,
  index: number,
  introduced: string[] = []
): string[] {
  const state = diagram.stages[index]!;
  const shown = diagram.nodes
    .map((node) => node.id)
    .filter((id) => state.visible.has(id));

  if (state.spotlight?.kind === 'focus') {
    const focused = state.spotlight.id;
    return [
      focused,
      ...shown.filter((id) => id !== focused && state.lit.has(id)),
    ];
  }
  if (state.spotlight) {
    const lit = shown.filter((id) => state.lit.has(id));
    return [
      ...lit.filter((id) => introduced.includes(id)),
      ...lit.filter((id) => !introduced.includes(id)),
    ];
  }
  return shown;
}

export function validateWalkthrough(
  model: ArchitectureWalkthrough
): ArchitectureWalkthrough {
  const unique = (ids: string[], kind: string) => {
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !/^[a-z][a-z\d-]*$/u.test(id))
    ) {
      throw new Error(`${model.id}: invalid or duplicate ${kind} IDs`);
    }
  };
  unique([model.id], 'walkthrough');
  unique(
    model.excerpts.map((excerpt) => excerpt.id),
    'excerpt'
  );
  unique(
    model.scenarios.map((scenario) => scenario.id),
    'scenario'
  );

  const nodes = Object.keys(model.diagram.nodes);
  const excerpts = new Set(model.excerpts.map((excerpt) => excerpt.id));
  for (const id of nodes) {
    const detail = model.details[id];
    if (!detail) {
      throw new Error(`${model.id}: node ${id} has no details`);
    }
    if (detail.source && !excerpts.has(detail.source)) {
      throw new Error(`${model.id}: node ${id} references a missing source`);
    }
  }
  for (const id of Object.keys(model.details)) {
    if (!nodes.includes(id)) {
      throw new Error(`${model.id}: details for unknown node ${id}`);
    }
  }

  if (!model.scenarios.length || !model.excerpts.length) {
    throw new Error(`${model.id}: a walkthrough needs source and scenarios`);
  }
  for (const excerpt of model.excerpts) {
    if (
      !model.scenarios.some((scenario) =>
        scenario.steps.some((step) => step.source.excerpt === excerpt.id)
      )
    ) {
      throw new Error(
        `${model.id}: source excerpt ${excerpt.id} has no linked step`
      );
    }
  }

  overviewDiagram(model);
  previewDiagram(model);
  for (const scenario of model.scenarios) {
    if (!scenario.steps.length) {
      throw new Error(`${model.id}: empty scenario ${scenario.id}`);
    }
    unique(
      scenario.steps.map((step) => step.id),
      'step'
    );
    // Throws on stage tokens that name nothing, so a broken step fails the build.
    defineArchitecture({
      ...model.diagram,
      stages: scenario.steps.map((step) => step.stage),
    });
    const diagram = scenarioDiagram(model, scenario);
    for (const [index, step] of scenario.steps.entries()) {
      const excerpt = model.excerpts.find(
        (entry) => entry.id === step.source.excerpt
      );
      if (!excerpt) {
        throw new Error(`${model.id}/${step.id}: missing source excerpt`);
      }
      if (stepNodes(diagram, index).length === 0) {
        throw new Error(`${model.id}/${step.id}: the step shows no nodes`);
      }
      const last = excerpt.startLine + excerpt.code.split('\n').length - 1;
      if (
        step.source.from < excerpt.startLine ||
        step.source.to > last ||
        step.source.to < step.source.from
      ) {
        throw new Error(`${model.id}/${step.id}: source range outside excerpt`);
      }
    }
  }
  return model;
}

export function publicState(model: ArchitectureWalkthrough): WalkthroughState {
  return {
    ...model,
    excerpts: model.excerpts.map(({ id, title, file, startLine }) => ({
      id,
      title,
      file,
      startLine,
    })),
  };
}

/** Render each complete source file once, even when several anchors refer to it. */
export function sourceFiles(
  model: ArchitectureWalkthrough
): { file: string; code: string }[] {
  const files = new Map<string, string>();
  for (const excerpt of model.excerpts) {
    if (files.has(excerpt.file) && files.get(excerpt.file) !== excerpt.source) {
      throw new Error(`${model.id}: conflicting source for ${excerpt.file}`);
    }
    files.set(excerpt.file, excerpt.source);
  }
  return [...files].map(([file, code]) => ({ file, code }));
}

export function sourceUrl(file: string, from: number, to = from): string {
  return `https://github.com/avenceslau/durability/blob/main/${file}#L${from}-L${to}`;
}
