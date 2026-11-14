/**
 * The Deploy to Cloudflare button copies a template's directory into a new
 * repository and installs it with npm. Nothing from this workspace comes
 * along, so a template that only works when linked to workspace packages
 * would deploy broken. This repeats those steps for every template.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
const templates = join(root, 'templates');

const run = (cwd, command, ...args) => {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
};

for (const name of readdirSync(templates)) {
  const source = join(templates, name);
  // Tracked and not-yet-tracked files, without anything git ignores.
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: source, encoding: 'utf8' }
  )
    .split('\n')
    .filter((file) => file.length > 0);

  const copy = mkdtempSync(join(tmpdir(), `template-${name}-`));
  for (const file of files) {
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    cpSync(join(source, file), join(copy, file));
  }

  console.log(`\n== ${name}: standalone copy in ${copy}`);
  run(copy, 'npm', 'install', '--no-audit', '--no-fund');
  run(copy, 'npm', 'run', 'typecheck');
  run(copy, 'npm', 'run', 'build');
  run(copy, 'npm', 'test');
  run(copy, 'npx', 'wrangler', 'deploy', '--dry-run');
  rmSync(copy, { recursive: true, force: true });
}
