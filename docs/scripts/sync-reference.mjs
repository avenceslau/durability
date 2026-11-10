import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packages = [
  ['storage', 'Storage'],
  ['transforms', 'RPC transforms'],
  ['lint', 'Lint rules'],
  ['tanstack-db', 'TanStack DB'],
];

// Keep the published READMEs as the source of truth for the detailed reference.
// Resolve repository-relative links before moving their content into the site.
await Promise.all(
  packages.map(async ([name, title]) => {
    const sourcePath = `packages/${name}/README.md`;
    const source = await readFile(resolve(root, sourcePath), 'utf8');
    const base = `https://github.com/avenceslau/durability/blob/main/${sourcePath}`;
    const body = source
      .replace(/^# .+\r?\n(?:[ \t]*\r?\n)*/u, '')
      .replace(/\]\(([^\s)]+)\)/gu, (match, href) => {
        if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/iu.test(href)) {
          return match;
        }
        return `](${new URL(href, base).href})`;
      });
    const target = resolve(root, `docs/src/content/docs/reference/${name}.md`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      `---\ntitle: ${title}\ndescription: Detailed API reference for ${name}.\nsourceEditUrl: https://github.com/avenceslau/durability/edit/main/${sourcePath}\n---\n\n${body}`
    );
  })
);
