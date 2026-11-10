import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publicState,
  scenarioDiagram,
  sourceExcerpt,
  sourceFocus,
  sourceFiles,
  sourceUrl,
  stepNodes,
  validateWalkthrough,
} from '../src/lib/architecture.ts';

const source =
  'class Jobs {\n  run() {\n    if (ready) {\n      send();\n    }\n    commit();\n  }\n}\n';
const excerpt = sourceExcerpt(
  source,
  'example.ts',
  'run',
  'Run a job',
  '  run()',
  '  }'
);
const focus = sourceFocus(excerpt, 'commit();');
const model = {
  id: 'test',
  title: 'Test',
  summary: 'Test',
  diagram: {
    canvas: { width: 900, height: 420 },
    nodes: {
      store: { label: 'Store', icon: 'database' },
      worker: { label: 'Worker' },
    },
    edges: [{ from: 'worker', to: 'store', label: 'write' }],
  },
  details: {
    store: { description: 'State', href: '/', source: 'run' },
    worker: { description: 'Caller', href: '/' },
  },
  excerpts: [excerpt],
  scenarios: [
    {
      id: 'normal',
      title: 'Normal',
      description: 'Normal',
      steps: [
        {
          id: 'commit',
          title: 'Commit',
          description: 'Commit',
          stage: ['worker', 'store', 'focus:store'],
          source: focus,
          durable: 'Committed',
          volatile: 'None',
          status: 'commit',
        },
      ],
    },
  ],
};

test('source excerpts keep actual text, original line numbers, and the outer closing brace', () => {
  assert.equal(excerpt.startLine, 2);
  assert.equal(excerpt.code, source.split('\n').slice(1, 7).join('\n'));
  assert.equal(excerpt.source, source);
  assert.deepEqual(sourceFiles(model), [{ file: 'example.ts', code: source }]);
  assert.deepEqual(focus, { excerpt: 'run', from: 6, to: 6 });
  assert.equal(
    sourceUrl(excerpt.file, 6),
    'https://github.com/avenceslau/durability/blob/main/example.ts#L6-L6'
  );
});

test('missing or ambiguous source anchors fail rather than showing stale code', () => {
  assert.throws(
    () => sourceExcerpt(source, 'test.ts', 'bad', 'Bad', 'missing', '  }'),
    /exactly once/u
  );
  assert.throws(
    () =>
      sourceExcerpt(source + source, 'test.ts', 'bad', 'Bad', 'run()', '  }'),
    /exactly once/u
  );
  assert.throws(
    () => sourceExcerpt(source, 'test.ts', 'bad', 'Bad', 'run()', 'never ends'),
    /ending source anchor/u
  );
  assert.throws(() => sourceFocus(excerpt, 'not-a-symbol'), /exactly once/u);
});

test('walkthrough references and source ranges are checked at build time', () => {
  assert.equal(validateWalkthrough(model), model);

  const unknownToken = structuredClone(model);
  unknownToken.scenarios[0].steps[0].stage = ['missing'];
  assert.throws(() => validateWalkthrough(unknownToken));

  const noDetails = structuredClone(model);
  delete noDetails.details.worker;
  assert.throws(() => validateWalkthrough(noDetails), /has no details/u);

  const outside = structuredClone(model);
  outside.scenarios[0].steps[0].source.to = 99;
  assert.throws(() => validateWalkthrough(outside), /outside excerpt/u);
});

test('every step shows the whole diagram and spotlights what it is about', () => {
  // A focused node comes first, ahead of the neighbours its spotlight lights.
  const lit = scenarioDiagram(model, model.scenarios[0]);
  assert.deepEqual(stepNodes(lit, 0), ['store', 'worker']);

  // A step without a spotlight focuses the node it introduces.
  const introduced = structuredClone(model);
  introduced.scenarios[0].steps = [
    { ...model.scenarios[0].steps[0], id: 'first', stage: ['worker'] },
    { ...model.scenarios[0].steps[0], id: 'second', stage: ['store'] },
  ];
  const diagram = scenarioDiagram(introduced, introduced.scenarios[0]);
  for (const state of diagram.stages) {
    assert.ok(state.visible.has('worker') && state.visible.has('store'));
    assert.ok(state.visible.has('worker->store'));
  }
  assert.equal(diagram.stages[0].spotlight.id, 'worker');
  assert.equal(diagram.stages[1].spotlight.id, 'store');
});

test('complete source files are deduplicated and cannot silently disagree', () => {
  const duplicate = structuredClone(model);
  duplicate.excerpts.push({ ...excerpt, id: 'another-anchor' });
  assert.deepEqual(sourceFiles(duplicate), [
    { file: 'example.ts', code: source },
  ]);
  duplicate.excerpts[1].source += '// different file contents';
  assert.throws(() => sourceFiles(duplicate), /conflicting source/u);
});

test('every code section must be linked and source text is not duplicated in browser state', () => {
  const invalid = structuredClone(model);
  invalid.excerpts.push({ ...excerpt, id: 'unused' });
  assert.throws(() => validateWalkthrough(invalid), /no linked step/u);
  const state = publicState(model);
  assert.equal('code' in state.excerpts[0], false);
  assert.equal('source' in state.excerpts[0], false);
  assert.equal(state.excerpts[0].startLine, 2);
});
