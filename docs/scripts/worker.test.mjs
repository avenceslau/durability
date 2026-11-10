import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import worker from '../src/worker.ts';

const noAssets = {
  ASSETS: { fetch: () => assert.fail('redirects must not fetch assets') },
};

for (const path of [
  '/',
  '/getting-started/?from=home',
  '/favicon.svg',
  '/missing/?q=a%2Fb',
]) {
  test(`apex redirects ${path} before asset lookup`, async () => {
    const response = await worker.fetch(
      new Request(`https://shirei.dev${path}`),
      noAssets
    );
    assert.equal(response.status, 308);
    assert.equal(
      response.headers.get('Location'),
      `https://durability.shirei.dev${path}`
    );
  });
}

test('redirect normalizes protocol and removes the incoming port', async () => {
  const response = await worker.fetch(
    new Request('http://shirei.dev:8080/concepts/?a=1'),
    noAssets
  );
  assert.equal(
    response.headers.get('Location'),
    'https://durability.shirei.dev/concepts/?a=1'
  );
});

for (const host of [
  'https://durability.shirei.dev',
  'http://durability.shirei.dev',
  'http://localhost:8787',
]) {
  test(`serves asset responses unchanged on ${host}`, async () => {
    const request = new Request(`${host}/missing/`, { method: 'HEAD' });
    const expected = new Response(null, { status: 404 });
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: (received) => {
          assert.equal(received, request);
          return Promise.resolve(expected);
        },
      },
    });
    assert.equal(response, expected);
    assert.equal(response.headers.get('Location'), null);
  });
}

test('Wrangler routes both domains through the Worker before matching assets', async () => {
  const source = await readFile(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8'
  );
  const { config, error } = ts.parseConfigFileTextToJson(
    'wrangler.jsonc',
    source
  );
  assert.equal(error, undefined);
  assert.equal(config.main, './src/worker.ts');
  assert.equal(config.assets.binding, 'ASSETS');
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.assets.not_found_handling, '404-page');
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.routes, [
    { pattern: 'durability.shirei.dev', custom_domain: true },
    { pattern: 'shirei.dev', custom_domain: true },
  ]);
});

// A token that can deploy this Worker can attach any KV namespace, R2 bucket,
// or D1 database in the account to it. Listing every allowed key means a
// binding, variable, or environment cannot be added without changing this test.
test('Wrangler config gives the Worker its assets and no other binding', async () => {
  const source = await readFile(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8'
  );
  const { config } = ts.parseConfigFileTextToJson('wrangler.jsonc', source);

  assert.deepEqual(Object.keys(config).sort(), [
    '$schema',
    'assets',
    'compatibility_date',
    'main',
    'name',
    'previews',
    'routes',
    'workers_dev',
  ]);
  assert.deepEqual(Object.keys(config.assets).sort(), [
    'binding',
    'directory',
    'not_found_handling',
    'run_worker_first',
  ]);
  assert.deepEqual(config.previews, {});
});
