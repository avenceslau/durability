// Packs the published packages, installs the tarballs into a throwaway project
// outside the pnpm workspace, and runs a real SQLite Durable Object smoke test
// against the shipped artifacts. This is the consumer/runtime layer that sits on
// top of the fast static `publint` gate: it proves the tarballs install,
// resolve their internal dependencies from the packed files (not the registry),
// typecheck, bundle into a Worker, and execute.
//
// Every failure is tagged with the stage that produced it (pack, manifest,
// install, resolve, types, bundle, runtime) so a red run points straight at the
// class of breakage.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const fixtureSrc = join(scriptDir, 'fixture');

// The package under test is `durability`; the other two are its internal
// dependencies, which must resolve from the packed tarballs rather than any
// published registry version.
const consumerPkg = 'durability';
const internalPkgs = ['@durability/storage', '@durability/transforms'];
const packDirs = { durability: 'durability', '@durability/storage': 'storage', '@durability/transforms': 'transforms' };

const channel = process.env['PACK_CONSUMER_CHANNEL'] === 'latest' ? 'latest' : 'pinned';

const log = (stage, message) => {
  console.log(`[pack:consumer] (${stage}) ${message}`);
};

const fail = (stage, message) => {
  console.error(`::error::[pack:consumer] (${stage}) ${message}`);
  process.exitCode = 1;
  throw new Error(`${stage}: ${message}`);
};

const run = (cmd, args, cwd) => {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
};

const capture = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8' });

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const tarballName = (name, version) =>
  `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;

const packageDir = (name) => join(repoRoot, 'packages', packDirs[name]);

// Resolve the toolchain the package is actually tested against, so the fixture
// cannot silently drift from the supported versions. The `latest` channel is an
// advisory early-warning signal for upstream breakage.
const toolchain = () => {
  if (channel === 'latest') {
    return {
      '@cloudflare/vitest-pool-workers': 'latest',
      '@cloudflare/workers-types': 'latest',
      typescript: 'latest',
      vitest: 'latest',
      wrangler: 'latest',
    };
  }
  const durability = readJson(join(packageDir('durability'), 'package.json'));
  const transforms = readJson(join(packageDir('@durability/transforms'), 'package.json'));
  const dev = durability.devDependencies ?? {};
  return {
    '@cloudflare/vitest-pool-workers': dev['@cloudflare/vitest-pool-workers'],
    '@cloudflare/workers-types': dev['@cloudflare/workers-types'],
    typescript: dev['typescript'],
    vitest: dev['vitest'],
    wrangler: transforms.devDependencies?.['wrangler'],
  };
};

const pack = (workdir) => {
  const packed = {};
  for (const name of [...internalPkgs, consumerPkg]) {
    const dir = packageDir(name);
    const version = readJson(join(dir, 'package.json')).version;
    // `prepack` builds dist, so packing also validates the build output.
    run('pnpm', ['pack', '--pack-destination', workdir], dir);
    packed[name] = { version, tarball: join(workdir, tarballName(name, version)) };
    log('pack', `packed ${name}@${version}`);
  }
  return packed;
};

const assertManifests = (packed) => {
  for (const [name, { tarball }] of Object.entries(packed)) {
    const manifestText = capture('tar', ['-xzOf', tarball, 'package/package.json']);
    if (manifestText.includes('workspace:')) {
      fail('manifest', `${name} tarball still contains a workspace: dependency range`);
    }
    const files = new Set(
      capture('tar', ['-tzf', tarball])
        .split('\n')
        .filter(Boolean)
        .map((entry) => entry.replace(/^package\//, ''))
    );
    for (const required of ['LICENSE', 'README.md']) {
      if (!files.has(required)) {
        fail('manifest', `${name} tarball is missing ${required}`);
      }
    }
    const manifest = JSON.parse(manifestText);
    for (const target of exportTargets(manifest.exports)) {
      if (!files.has(target)) {
        fail('manifest', `${name} exports ${target} but the tarball does not contain it`);
      }
    }
    log('manifest', `${name} tarball manifest and export targets verified`);
  }
};

const exportTargets = (exports) => {
  const targets = [];
  const visit = (value) => {
    if (typeof value === 'string') {
      targets.push(value.replace(/^\.\//, ''));
      return;
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) {
        visit(nested);
      }
    }
  };
  visit(exports);
  return targets;
};

const writeFixture = (workdir, packed, versions) => {
  cpSync(fixtureSrc, workdir, { recursive: true });

  const fileRef = (name) => `file:./${tarballName(name, packed[name].version)}`;
  const pkg = {
    name: 'durability-consumer-smoke',
    private: true,
    type: 'module',
    scripts: {
      typecheck: 'tsc --noEmit',
      bundle: 'wrangler deploy --dry-run --outdir dist-dry',
      test: 'vitest run',
    },
    dependencies: {
      durability: fileRef('durability'),
      '@durability/storage': fileRef('@durability/storage'),
      '@durability/transforms': fileRef('@durability/transforms'),
    },
    devDependencies: versions,
  };
  writeFileSync(join(workdir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  const overrides = internalPkgs
    .map((name) => `  "${name}": "${fileRef(name)}"`)
    .join('\n');
  writeFileSync(
    join(workdir, 'pnpm-workspace.yaml'),
    `packages: []\noverrides:\n${overrides}\n`
  );

  // Install as a real public-registry consumer, ignoring any workspace-scoped
  // registry from the developer's global config.
  writeFileSync(
    join(workdir, '.npmrc'),
    'registry=https://registry.npmjs.org/\n@cloudflare:registry=https://registry.npmjs.org/\n'
  );
};

const assertResolvedFromTarballs = (workdir) => {
  const lock = readFileSync(join(workdir, 'pnpm-lock.yaml'), 'utf8');
  const lines = lock.split('\n');
  for (const name of internalPkgs) {
    const registryResolved = lines.some((line) =>
      line.trim().startsWith(`'${name}@`) && !line.includes('file:')
    );
    if (registryResolved) {
      fail('resolve', `${name} resolved from the registry instead of the packed tarball`);
    }
  }
  log('resolve', 'internal dependencies resolved from packed tarballs');
};

const main = () => {
  const versions = toolchain();
  for (const [name, version] of Object.entries(versions)) {
    if (!version) {
      fail('pack', `could not determine the ${channel} version for ${name}`);
    }
  }
  log('pack', `toolchain channel: ${channel}`);

  const workdir = mkdtempSync(join(tmpdir(), 'durability-consumer-'));
  log('pack', `fixture directory: ${workdir}`);

  try {
    const packed = pack(workdir);
    assertManifests(packed);

    writeFixture(workdir, packed, versions);

    log('install', 'installing packed tarballs outside the workspace');
    run('pnpm', ['install', '--prefer-offline', '--ignore-scripts'], workdir);
    assertResolvedFromTarballs(workdir);

    log('types', 'typechecking public imports');
    run('pnpm', ['run', 'typecheck'], workdir);

    log('bundle', 'bundling the Worker with wrangler --dry-run');
    run('pnpm', ['run', 'bundle'], workdir);

    log('runtime', 'running the SQLite Durable Object smoke test in workerd');
    run('pnpm', ['run', 'test'], workdir);

    log('runtime', 'packed artifact smoke test passed');
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
};

main();
