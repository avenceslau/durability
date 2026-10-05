import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { getReleasePackages } from './release-packages.mjs';

const root = path.resolve(process.env.RELEASE_ROOT ?? process.cwd());
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;

if (!repository || !token) {
  throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
}

const run = (command, args) =>
  spawnSync(command, args, {
    cwd: root,
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

const releaseExists = async (tag) => {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  if (response.status === 200) {
    return true;
  }
  if (response.status === 404) {
    return false;
  }

  throw new Error(
    `GitHub release lookup for ${tag} failed: ${response.status} ${await response.text()}`
  );
};

const headResult = run('git', ['rev-parse', 'HEAD']);
if (headResult.status !== 0) {
  throw commandError('git', ['rev-parse', 'HEAD'], headResult);
}
const releaseCommit = headResult.stdout.trim();
const parentResult = run('git', ['rev-parse', 'HEAD^']);
if (parentResult.status !== 0) {
  throw commandError('git', ['rev-parse', 'HEAD^'], parentResult);
}
const parentCommit = parentResult.stdout.trim();
const packages = await getReleasePackages(root);
const candidates = [];
const unpublished = [];

for (const { directory, manifest } of packages) {
  const manifestPath = path
    .relative(root, path.join(directory, 'package.json'))
    .split(path.sep)
    .join('/');
  const previousManifestResult = run('git', [
    'show',
    `${parentCommit}:${manifestPath}`,
  ]);
  const previousVersion =
    previousManifestResult.status === 0
      ? JSON.parse(previousManifestResult.stdout).version
      : undefined;
  const { name, version } = manifest;
  if (previousVersion === version) {
    continue;
  }

  const tag = `${name}@${version}`;
  const viewArgs = ['view', `${name}@${version}`, 'version', '--json'];
  const viewResult = run('npm', viewArgs);

  if (viewResult.status !== 0 || JSON.parse(viewResult.stdout) !== version) {
    unpublished.push(`${name}@${version}`);
    continue;
  }

  const tagResult = run('git', [
    'rev-parse',
    '--quiet',
    '--verify',
    `refs/tags/${tag}^{commit}`,
  ]);
  const hasTag = tagResult.status === 0;
  if (hasTag && tagResult.stdout.trim() !== releaseCommit) {
    throw new Error(
      `Tag ${tag} points to ${tagResult.stdout.trim()}, expected ${releaseCommit}`
    );
  }

  candidates.push({ tag, hasTag });
}

if (unpublished.length > 0) {
  throw new Error(
    `Approve these staged versions before finalizing:\n${unpublished.join('\n')}`
  );
}

const candidatesWithReleases = await Promise.all(
  candidates.map(async (candidate) => ({
    ...candidate,
    hasRelease: await releaseExists(candidate.tag),
  }))
);
const pending = [];

for (const { tag, hasTag, hasRelease } of candidatesWithReleases) {
  if (hasRelease && !hasTag) {
    throw new Error(`GitHub release ${tag} exists without its git tag`);
  }
  if (!hasRelease) {
    pending.push({ tag, hasTag });
  }
}

for (const { tag, hasTag } of pending) {
  if (!hasTag) {
    const result = run('git', ['tag', tag]);
    if (result.status !== 0) {
      throw commandError('git', ['tag', tag], result);
    }
  }

  // changesets/action uses this output to push the tag and create its release.
  console.log(`New tag: ${tag}`);
}

if (pending.length === 0) {
  console.log('All package tags and GitHub releases already exist');
}
