import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publicState,
  sourceExcerpt,
  sourceFocus,
  sourceFiles,
  sourceUrl,
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
  width: 900,
  height: 420,
  nodes: [
    {
      id: 'store',
      title: 'Store',
      kind: 'durable',
      description: 'State',
      href: '/',
      x: 150,
      y: 80,
    },
  ],
  edges: [],
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
          nodes: ['store'],
          edges: [],
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
  const invalid = structuredClone(model);
  invalid.scenarios[0].steps[0].nodes = ['missing'];
  assert.throws(
    () => validateWalkthrough(invalid),
    /invalid diagram\/source reference/u
  );
  invalid.scenarios[0].steps[0].nodes = ['store'];
  invalid.scenarios[0].steps[0].source.to = 99;
  assert.throws(() => validateWalkthrough(invalid), /outside excerpt/u);
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
