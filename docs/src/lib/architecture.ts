export type ArchitectureNode = {
  id: string;
  title: string;
  kind: 'compute' | 'durable' | 'memory' | 'external';
  description: string;
  href: string;
  source?: string;
  x: number;
  y: number;
};

export type ArchitectureEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
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
  nodes: string[];
  edges: string[];
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
  width: number;
  height: number;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
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
    model.nodes.map((node) => node.id),
    'node'
  );
  unique(
    model.edges.map((edge) => edge.id),
    'edge'
  );
  unique(
    model.excerpts.map((excerpt) => excerpt.id),
    'excerpt'
  );
  unique(
    model.scenarios.map((scenario) => scenario.id),
    'scenario'
  );
  const nodes = new Set(model.nodes.map((node) => node.id));
  const edges = new Set(model.edges.map((edge) => edge.id));
  const excerpts = new Set(model.excerpts.map((excerpt) => excerpt.id));
  for (const node of model.nodes) {
    if (node.source && !excerpts.has(node.source)) {
      throw new Error(
        `${model.id}: node ${node.id} references a missing source`
      );
    }
    if (
      node.x < 90 ||
      node.x > model.width - 90 ||
      node.y < 45 ||
      node.y > model.height - 45
    ) {
      throw new Error(`${model.id}: node ${node.id} falls outside the diagram`);
    }
  }
  for (const edge of model.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      throw new Error(`${model.id}: edge ${edge.id} references a missing node`);
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
  for (const scenario of model.scenarios) {
    if (!scenario.steps.length) {
      throw new Error(`${model.id}: empty scenario ${scenario.id}`);
    }
    unique(
      scenario.steps.map((step) => step.id),
      'step'
    );
    for (const step of scenario.steps) {
      const excerpt = model.excerpts.find(
        (entry) => entry.id === step.source.excerpt
      );
      if (
        !excerpt ||
        !step.nodes.length ||
        step.nodes.some((id) => !nodes.has(id)) ||
        step.edges.some((id) => !edges.has(id))
      ) {
        throw new Error(
          `${model.id}/${step.id}: invalid diagram/source reference`
        );
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
