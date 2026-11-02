import assert from 'node:assert/strict';
import test from 'node:test';
import { pointOnPath } from '../src/kit/architecture/geometry.ts';
import {
  crossings,
  edgeGeometry,
  nodeRect,
} from '../src/kit/architecture/layout.ts';
import { readdirSync } from 'node:fs';
import { overviewDiagram, scenarioDiagram } from '../src/lib/architecture.ts';

function shownRects(state) {
  return [...state.layout.nodes].flatMap(([id, center]) => {
    const view = state.nodes.get(id);
    return state.visible.has(id) && view !== undefined
      ? [[id, nodeRect(view, center, state.layout.scale)]]
      : [];
  });
}

function overlaps(a, b) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function overlappingNodes(state) {
  const rects = shownRects(state);
  return rects.flatMap(([a, rectA], index) =>
    rects
      .slice(index + 1)
      .filter(([, rectB]) => overlaps(rectA, rectB))
      .map(([b]) => `${a} overlaps ${b}`)
  );
}

function edgeLines(diagram, state) {
  const rects = new Map(shownRects(state));
  return diagram.edges
    .filter((edge) => state.visible.has(edge.id))
    .map((edge) => {
      const [from, to] = state.ends.get(edge.id) ?? [edge.from, edge.to];
      const { path } = edgeGeometry(
        edge,
        state.layout.edges.get(edge.id),
        rects.get(from),
        rects.get(to)
      );
      return {
        id: edge.id,
        ends: [from, to],
        points: Array.from({ length: 81 }, (_, index) =>
          pointOnPath(path, index / 80)
        ),
      };
    });
}

function crossingEdges(lines) {
  return lines.flatMap((a, index) =>
    lines
      .slice(index + 1)
      .filter((b) => crossings(a.points, b.points) > 0)
      .map((b) => `${a.id} x ${b.id}`)
  );
}

function edgesThroughNodes(lines, state) {
  const rects = shownRects(state);
  return lines.flatMap((line) =>
    rects
      .filter(([id]) => !line.ends.includes(id))
      .filter(([, rect]) =>
        line.points.some(
          ([x, y]) =>
            x > rect.x &&
            x < rect.x + rect.width &&
            y > rect.y &&
            y < rect.y + rect.height
        )
      )
      .map(([id]) => `${line.id} passes through ${id}`)
  );
}

// Vite globs these in src/architecture/index.ts; Node lists the same files.
const directory = new URL('../src/architecture/', import.meta.url);
const files = readdirSync(directory).filter(
  (file) => file.endsWith('.ts') && file !== 'index.ts'
);
const models = await Promise.all(
  files.map(
    async (file) => (await import(new URL(file, directory).href)).walkthrough
  )
);

for (const model of models) {
  const diagrams = [
    ['overview', overviewDiagram(model)],
    ...model.scenarios.map((scenario) => [
      scenario.id,
      scenarioDiagram(model, scenario),
    ]),
  ];
  for (const [name, diagram] of diagrams) {
    test(`${model.id}/${name}: no nodes overlap and no edge crosses another edge or a node`, () => {
      for (const [index, state] of diagram.stages.entries()) {
        const lines = edgeLines(diagram, state);
        assert.deepEqual(overlappingNodes(state), [], `stage ${index}`);
        assert.deepEqual(crossingEdges(lines), [], `stage ${index}`);
        assert.deepEqual(edgesThroughNodes(lines, state), [], `stage ${index}`);
      }
    });
  }
}
