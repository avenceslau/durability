import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getReleasePackages } from './release-packages.mjs';

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const root = path.resolve(process.env.RELEASE_ROOT ?? scriptRoot);
const summary = process.env.GITHUB_STEP_SUMMARY;

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const run = (command, args, cwd = root) =>
  spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

const commandError = (command, args, result) => {
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim();
  return new Error(`${command} ${args.join(' ')} failed\n${output}`);
};

const isPublished = (name, version) => {
  const args = ['view', `${name}@${version}`, 'version', '--json'];
  const result = run('npm', args);

  if (result.status === 0) {
    return JSON.parse(result.stdout) === version;
  }

  if (/E404|404 Not Found/.test(result.stderr)) {
    return false;
  }

  throw commandError('npm', args, result);
};

const findStageId = (value) => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if (typeof value.stageId === 'string') {
    return value.stageId;
  }

  for (const child of Object.values(value)) {
    const stageId = findStageId(child);
    if (stageId) {
      return stageId;
    }
  }

  return undefined;
};

const packages = await getReleasePackages(root);
const unpublished = packages.filter(
  ({ manifest }) => !isPublished(manifest.name, manifest.version)
);

if (process.argv.includes('--list')) {
  console.log(
    JSON.stringify(
      unpublished.map(({ manifest }) => ({
        name: manifest.name,
        version: manifest.version,
      }))
    )
  );
  process.exit(0);
}

const packageName = argument('--package');
const pkg = unpublished.find(({ manifest }) => manifest.name === packageName);
if (!pkg) {
  const knownPackage = packages.find(
    ({ manifest }) => manifest.name === packageName
  );
  if (knownPackage) {
    console.log(
      `Skipping ${knownPackage.manifest.name}@${knownPackage.manifest.version}: already published`
    );
    process.exit(0);
  }

  throw new Error('Pass --list or --package <name>');
}

const { name, version } = pkg.manifest;
if (version.includes('-')) {
  throw new Error(
    `Cannot stage prerelease ${name}@${version} without an explicit dist-tag policy`
  );
}

const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), 'durability-stage-')
);
const tarball = path.join(temporaryDirectory, 'package.tgz');

try {
  const packArgs = ['pack', '--out', tarball];
  const packResult = run('pnpm', packArgs, pkg.directory);
  if (packResult.status !== 0) {
    throw commandError('pnpm', packArgs, packResult);
  }

  const manifestResult = run('tar', ['-xOf', tarball, 'package/package.json']);
  if (manifestResult.status !== 0) {
    throw commandError(
      'tar',
      ['-xOf', tarball, 'package/package.json'],
      manifestResult
    );
  }
  if (manifestResult.stdout.includes('workspace:')) {
    throw new Error(
      `${name}@${version} contains an unresolved workspace range`
    );
  }

  if (process.argv.includes('--dry-run')) {
    console.log(`Would stage ${name}@${version}`);
  } else {
    const stageArgs = [
      'stage',
      'publish',
      tarball,
      '--access',
      'public',
      '--tag',
      'latest',
      '--provenance',
      '--ignore-scripts',
      '--json',
    ];
    const stageResult = run('npm', stageArgs, pkg.directory);
    if (stageResult.status !== 0) {
      const error = commandError('npm', stageArgs, stageResult);
      error.message +=
        '\nIf the upload may have succeeded, inspect npm stage list before retrying.';
      throw error;
    }

    const stageId = findStageId(JSON.parse(stageResult.stdout));
    if (!stageId) {
      throw new Error(`npm did not return a stage ID for ${name}@${version}`);
    }

    console.log(`Staged ${name}@${version}: ${stageId}`);
    if (summary) {
      const releaseSha = process.env.RELEASE_SHA ?? process.env.GITHUB_SHA;
      await appendFile(
        summary,
        [
          `## Staged ${name}@${version}`,
          '',
          `- Stage ID: \`${stageId}\``,
          `- Release commit: \`${releaseSha}\``,
          '',
          `Approve with \`npm stage approve ${stageId}\` after inspection.`,
          '',
        ].join('\n')
      );
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
