import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const getReleasePackages = async (root) => {
  const packageEntries = await readdir(path.join(root, 'packages'), {
    withFileTypes: true,
  });
  const directories = [
    path.join(root, 'examples'),
    ...packageEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, 'packages', entry.name)),
  ];
  const packages = (
    await Promise.all(
      directories.map(async (directory) => {
        const manifest = JSON.parse(
          await readFile(path.join(directory, 'package.json'), 'utf8')
        );
        return manifest.private ? undefined : { directory, manifest };
      })
    )
  ).filter(Boolean);

  const packagesByName = new Map(
    packages.map((pkg) => [pkg.manifest.name, pkg])
  );
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  const visit = (pkg) => {
    const { name } = pkg.manifest;
    if (visited.has(name)) {
      return;
    }
    if (visiting.has(name)) {
      throw new Error(`Workspace dependency cycle includes ${name}`);
    }

    visiting.add(name);
    const dependencies = {
      ...pkg.manifest.dependencies,
      ...pkg.manifest.optionalDependencies,
    };
    for (const dependency of Object.keys(dependencies)) {
      const workspacePackage = packagesByName.get(dependency);
      if (workspacePackage) {
        visit(workspacePackage);
      }
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(pkg);
  };

  for (const pkg of packages) {
    visit(pkg);
  }

  return ordered;
};
