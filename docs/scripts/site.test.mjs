import assert from 'node:assert/strict';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const output = fileURLToPath(new URL('../dist/', import.meta.url));
const routes = (await readdir(output, { recursive: true }))
  .filter((file) => file === 'index.html' || file.endsWith('/index.html'))
  .map((file) => file.replace(/(?:^|\/)index\.html$/u, ''));
const primitives = [
  'operations',
  'alarms',
  'scheduler',
  'fanout',
  'log',
  'routing',
  'socket',
  'client',
  'outbox',
  'schedule',
  'tracker',
  'topology',
  'semaphore',
  'semaphore-queue',
];

for (const route of routes) {
  test(`renders /${route}`, async () => {
    const html = await readFile(resolve(output, route, 'index.html'), 'utf8');
    assert.match(html, /<title>/u);
    assert.match(html, /Durability/u);
    assert.match(html, /<main/u);
  });
}

test('includes the search index and a real 404 page', async () => {
  await access(resolve(output, 'pagefind/pagefind.js'));
  const html = await readFile(resolve(output, '404.html'), 'utf8');
  assert.match(html, /404/u);
});

test('internal page links and anchors resolve in the built site', async () => {
  await Promise.all(
    routes.map(async (route) => {
      const html = await readFile(resolve(output, route, 'index.html'), 'utf8');
      const origin = new URL(
        `https://durability.shirei.dev/${route}${route ? '/' : ''}`
      );
      await Promise.all(
        [...html.matchAll(/href="([^"\s]+)"/gu)].map(async (match) => {
          const href = match[1];
          const target = new URL(href, origin);
          if (target.origin !== origin.origin) {
            return;
          }
          const path = decodeURIComponent(target.pathname).replace(/^\//u, '');
          if (path.startsWith('_astro/') || path.startsWith('pagefind/')) {
            return;
          }
          let file =
            path.endsWith('/') || path === ''
              ? resolve(output, path, 'index.html')
              : resolve(output, path);
          if ((await stat(file)).isDirectory()) {
            file = resolve(file, 'index.html');
          }
          const body = await readFile(file, 'utf8');
          if (target.hash) {
            const id = decodeURIComponent(target.hash.slice(1));
            assert.ok(
              body.includes(`id="${id}"`),
              `/${route}: ${href} has no matching anchor`
            );
          }
        })
      );
    })
  );
});

test('canonical URLs and the sitemap use the docs domain', async () => {
  const html = await readFile(
    resolve(output, 'getting-started/index.html'),
    'utf8'
  );
  assert.match(
    html,
    /rel="canonical" href="https:\/\/durability\.shirei\.dev\/getting-started\/"/u
  );
  const sitemap = await readFile(resolve(output, 'sitemap-0.xml'), 'utf8');
  assert.match(
    sitemap,
    /https:\/\/durability\.shirei\.dev\/getting-started\//u
  );
  assert.doesNotMatch(sitemap, /https:\/\/shirei\.dev\//u);
});

for (const primitive of primitives) {
  test(`${primitive} has its own source file and explains its internals`, async () => {
    const source = await readFile(
      new URL(
        `../src/content/docs/primitives/${primitive}.md`,
        import.meta.url
      ),
      'utf8'
    );
    assert.match(source, /^## Behind the scenes$/mu);
    assert.match(source, /packages\/durability\/src\//u);
    assert.ok(routes.includes(`primitives/${primitive}`));
  });
}

test('primitives are no longer bundled into a monolithic reference page', async () => {
  assert.ok(!routes.includes('reference/durability'));
});

test('Nimbus publishes readable walkthrough fallbacks for agents', async () => {
  await access(resolve(output, 'llms.txt'));
  await access(resolve(output, '.well-known/ard.json'));
  await Promise.all(
    [
      'recurring-billing',
      'email-delivery',
      'job-dashboard',
      'account-concurrency',
      'event-stream',
    ].map(async (slug) => {
      const markdown = await readFile(
        resolve(output, `compositions/${slug}/index.md`),
        'utf8'
      );
      assert.match(
        markdown,
        /full-screen explorer with the complete source files/u
      );
      assert.doesNotMatch(markdown, /<ArchitectureWalkthrough/u);
    })
  );
});

test('ordinary page edit links point to the actual source once', async () => {
  const html = await readFile(
    resolve(output, 'getting-started/index.html'),
    'utf8'
  );
  assert.match(
    html,
    /edit\/main\/docs\/src\/content\/docs\/getting-started\.md/u
  );
  assert.doesNotMatch(html, /docs\/src\/content\/docs\/src\/content/u);
});

test('companion package references still point to their source READMEs', async () => {
  const html = await readFile(
    resolve(output, 'reference/transforms/index.html'),
    'utf8'
  );
  assert.match(html, /edit\/main\/packages\/transforms\/README\.md/u);
});
