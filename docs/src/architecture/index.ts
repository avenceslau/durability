import type { ArchitectureWalkthrough } from '../lib/architecture.ts';

// One walkthrough per file, named by the `example` the page passes.
const modules = import.meta.glob<{ walkthrough: ArchitectureWalkthrough }>(
  './*.ts',
  { eager: true }
);

export const walkthroughs: Record<string, ArchitectureWalkthrough> =
  Object.fromEntries(
    Object.entries(modules)
      .filter(([path]) => path !== './index.ts')
      .map(([path, module]) => [
        path.slice('./'.length, -'.ts'.length),
        module.walkthrough,
      ])
  );

export type WalkthroughExample = string;
