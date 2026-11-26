import type { Scope } from './scopes.js';
import { durableObjectExportName } from './routing.js';
import {
  identifierName,
  isStringLiteral,
  propertyKeyName,
  syntaxNode,
  unwrapExpression,
  type SyntaxNode,
} from './syntax.js';
import type { WranglerProject } from './wrangler.js';
import { unusedName } from './wrap.js';

const cacheModule = '@durability/transforms/cache';
const identifierPattern = /^[A-Z_$][\w$]*$/i;

type CacheEntrypoint = {
  entrypointName: string;
  planName: string;
  durableObjectExportName: string;
};

const nodeList = (value: unknown): SyntaxNode[] =>
  Array.isArray(value) ? value.flatMap((item) => syntaxNode(item) ?? []) : [];

function cachePlanValueImportNames(program: SyntaxNode): Set<string> {
  const names = new Set<string>();

  for (const statement of nodeList(program.body)) {
    const source = syntaxNode(statement.source);

    if (
      statement.type !== 'ImportDeclaration' ||
      !isStringLiteral(source) ||
      source.value !== cacheModule ||
      statement.importKind === 'type'
    ) {
      continue;
    }

    for (const specifier of nodeList(statement.specifiers)) {
      const localName = identifierName(syntaxNode(specifier.local));

      if (
        specifier.type === 'ImportSpecifier' &&
        specifier.importKind !== 'type' &&
        identifierName(syntaxNode(specifier.imported)) === 'cachePlan' &&
        localName !== undefined
      ) {
        names.add(localName);
      }
    }
  }

  return names;
}

function topLevelConstants(program: SyntaxNode): SyntaxNode[] {
  return nodeList(program.body).flatMap((statement) => {
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? syntaxNode(statement.declaration)
        : statement;

    return declaration?.type === 'VariableDeclaration' &&
      declaration.kind === 'const'
      ? nodeList(declaration.declarations)
      : [];
  });
}

function planTargetName(planName: string, call: SyntaxNode): string {
  const typeArguments = syntaxNode(call.typeArguments ?? call.typeParameters);
  const [typeArgument, ...rest] = nodeList(typeArguments?.params);
  const targetName = identifierName(syntaxNode(typeArgument?.typeName));

  if (
    typeArgument?.type !== 'TSTypeReference' ||
    rest.length > 0 ||
    targetName === undefined
  ) {
    throw new Error(
      `cachePlan "${planName}" must name its Durable Object class as the only type argument, as in cachePlan<Account>()`
    );
  }

  return targetName;
}

function entrypointOption(
  planName: string,
  call: SyntaxNode
): string | false | undefined {
  const [options] = nodeList(call.arguments);

  if (options === undefined) {
    return undefined;
  }

  const unwrapped = unwrapExpression(options);

  if (unwrapped?.type !== 'ObjectExpression') {
    throw new Error(
      `cachePlan "${planName}" options must be an object literal so the Vite plugin can read its entrypoint`
    );
  }

  const entrypoint = nodeList(unwrapped.properties).find(
    (property) =>
      property.type === 'ObjectProperty' &&
      property.computed !== true &&
      propertyKeyName(property) === 'entrypoint'
  );

  if (entrypoint === undefined) {
    return undefined;
  }

  const entrypointValue = unwrapExpression(syntaxNode(entrypoint.value));

  if (
    entrypointValue?.type === 'BooleanLiteral' &&
    entrypointValue.value === false
  ) {
    return false;
  }

  if (
    isStringLiteral(entrypointValue) &&
    identifierPattern.test(entrypointValue.value)
  ) {
    return entrypointValue.value;
  }

  throw new Error(
    `cachePlan "${planName}" entrypoint must be false or a string literal that is a valid class name`
  );
}

function assertCacheEnabled(
  project: WranglerProject,
  planName: string,
  entrypointName: string
): void {
  const configured = project.config.exports[entrypointName];

  if (configured?.type === 'worker' && configured.cache?.enabled === true) {
    return;
  }

  const snippet = JSON.stringify({
    exports: {
      [entrypointName]: { type: 'worker', cache: { enabled: true } },
    },
  });

  throw new Error(
    `cachePlan "${planName}" generates the entrypoint ${entrypointName}, which needs the Workers cache enabled. Add ${snippet} to ${project.configPath}`
  );
}

export function collectCacheEntrypoints(
  program: SyntaxNode,
  rootScope: Scope,
  project: WranglerProject
): CacheEntrypoint[] {
  const planFactories = cachePlanValueImportNames(program);

  if (planFactories.size === 0) {
    return [];
  }

  const entrypoints: CacheEntrypoint[] = [];

  for (const declarator of topLevelConstants(program)) {
    const planName = identifierName(syntaxNode(declarator.id));
    const outerCall = unwrapExpression(syntaxNode(declarator.init));
    const innerCall = unwrapExpression(syntaxNode(outerCall?.callee));

    const factoryName = identifierName(
      unwrapExpression(syntaxNode(innerCall?.callee))
    );

    if (
      planName === undefined ||
      outerCall?.type !== 'CallExpression' ||
      innerCall?.type !== 'CallExpression' ||
      factoryName === undefined ||
      !planFactories.has(factoryName)
    ) {
      continue;
    }

    const entrypoint = entrypointOption(planName, innerCall);

    // A hand-written entrypoint may serve any target, so nothing is checked.
    if (entrypoint === false) {
      continue;
    }

    const targetExportName = durableObjectExportName(
      program,
      planTargetName(planName, innerCall),
      project.bindings.durableObjectClassNames,
      `cachePlan "${planName}" target`,
      'set cachePlan({ entrypoint: false }) and write the entrypoint with serveCached'
    );

    const entrypointName = entrypoint ?? `${targetExportName}Reads`;

    if (
      rootScope.bindings.has(entrypointName) ||
      entrypoints.some((planned) => planned.entrypointName === entrypointName)
    ) {
      throw new Error(
        `cachePlan "${planName}" generates the entrypoint ${entrypointName}, but the module already declares that name; set cachePlan({ entrypoint }) to another name or false`
      );
    }

    assertCacheEnabled(project, planName, entrypointName);

    entrypoints.push({
      entrypointName,
      planName,
      durableObjectExportName: targetExportName,
    });
  }

  return entrypoints;
}

export function cacheEntrypointCode(
  code: string,
  entrypoints: CacheEntrypoint[]
): string {
  const entrypointClass = unusedName(code, '__durabilityWorkerEntrypoint');
  const workerExports = unusedName(code, '__durabilityWorkerExports');
  const serve = unusedName(code, '__durabilityServeCached');

  const classes = entrypoints.map(
    ({ entrypointName, planName, durableObjectExportName }) => `
export class ${entrypointName} extends ${entrypointClass} {
  fetch(request) {
    return ${serve}(request, ${planName}, {
      namespace: ${workerExports}[${JSON.stringify(durableObjectExportName)}],
    });
  }
}
`
  );

  return [
    '',
    `import { WorkerEntrypoint as ${entrypointClass}, exports as ${workerExports} } from 'cloudflare:workers';`,
    `import { serveCached as ${serve} } from '${cacheModule}';`,
    ...classes,
  ].join('\n');
}
