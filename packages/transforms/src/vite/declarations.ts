import { writeFileSync } from 'node:fs';
import { dirname, extname, relative } from 'node:path';
import { parse as parseJavaScript } from '@babel/parser';
import { forEachChild, identifierName, syntaxNode } from './syntax.js';
import { generateEnvTypes, type WranglerProject } from './wrangler.js';

const identifierPattern = /^[A-Z_$][\w$]*$/i;

const durableObjectNamespaceType = `
type TransformDurableObjectNamespace<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
> = Omit<DurableObjectNamespace<T>, 'get' | 'getByName'> & {
  get(
    id: DurableObjectId,
    options?: DurableObjectNamespaceGetDurableObjectOptions
  ): TransformStub<DurableObjectStub<T>>;
  getByName(
    name: string,
    options?: DurableObjectNamespaceGetDurableObjectOptions
  ): TransformStub<DurableObjectStub<T>>;
};
`;

/**
 * Reads binding types from `wrangler types` output. Types that Wrangler could
 * not resolve carry a placeholder comment and are skipped so they do not
 * conflict with hand-written declarations.
 */
function wranglerBindingTypes(source: string): Map<string, string> {
  const ast = parseJavaScript(source, {
    sourceType: 'script',
    plugins: [['typescript', { dts: true }]],
  });
  const types = new Map<string, string>();
  const visit = (value: unknown): void => {
    const node = syntaxNode(value);
    if (!node) {
      return;
    }

    const annotation = syntaxNode(
      syntaxNode(node['typeAnnotation'])?.['typeAnnotation']
    );
    const name = identifierName(syntaxNode(node.key));
    if (
      node.type === 'TSPropertySignature' &&
      name !== undefined &&
      !types.has(name) &&
      typeof node.start === 'number' &&
      typeof node.end === 'number' &&
      typeof annotation?.start === 'number' &&
      typeof annotation.end === 'number' &&
      !source.slice(node.start, node.end).includes('/*')
    ) {
      types.set(name, source.slice(annotation.start, annotation.end));
    }

    forEachChild(node, visit);
  };

  visit(ast);
  return types;
}

function declarationContents(
  project: WranglerProject,
  modulePath: string,
  envTypes: string
): string {
  const durableObjects = project.config.durable_objects.bindings.map(
    (binding) => ({
      key: identifierPattern.test(binding.name)
        ? binding.name
        : JSON.stringify(binding.name),
      localClass:
        binding.script_name === undefined &&
        identifierPattern.test(binding.class_name)
          ? `import(${JSON.stringify(modulePath)}).${binding.class_name}`
          : undefined,
    })
  );

  const bindingTypes = wranglerBindingTypes(envTypes);
  const stubs = [...project.bindings.stubBindingNames].flatMap((name) => {
    const type = bindingTypes.get(name);
    if (type === undefined) {
      return [];
    }
    return [
      {
        key: identifierPattern.test(name) ? name : JSON.stringify(name),
        type,
      },
    ];
  });

  const members = (indent: string) =>
    [
      ...durableObjects.map(({ key, localClass }) =>
        localClass
          ? `${indent}${key}: TransformDurableObjectNamespace<\n${indent}  ${localClass}\n${indent}>;`
          : `${indent}${key}: TransformDurableObjectNamespace;`
      ),
      ...stubs.map(
        ({ key, type }) => `${indent}${key}: TransformStub<${type}>;`
      ),
    ].join('\n');

  return `import type { TransformStub } from '@durability/transforms';
${durableObjects.length === 0 ? '' : durableObjectNamespaceType}
declare global {
  interface Env {
${members('    ')}
  }

  namespace Cloudflare {
    interface Env {
${members('      ')}
    }
  }
}

export {};
`;
}

/**
 * Writes declarations that give every wrapped binding in `Env` its
 * transformable type, importing local Durable Object classes from `mainPath`.
 */
export async function writeBindingDeclarations(
  project: WranglerProject,
  mainPath: string,
  typesPath: string
): Promise<void> {
  if (!typesPath.endsWith('.d.ts')) {
    throw new Error(`do-transforms types path must end in .d.ts: ${typesPath}`);
  }

  let modulePath = relative(dirname(typesPath), mainPath).split('\\').join('/');
  modulePath = modulePath.slice(0, -extname(modulePath).length);
  if (!modulePath.startsWith('.')) {
    modulePath = `./${modulePath}`;
  }

  const envTypes = await generateEnvTypes(project.configPath, typesPath);
  writeFileSync(typesPath, declarationContents(project, modulePath, envTypes));
}
