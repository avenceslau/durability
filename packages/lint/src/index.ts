type TemplateElementValue = { cooked?: string | null; raw?: string };

type AstNode = {
  type: string;
  name?: string;
  value?: string | number | boolean | null | AstNode | TemplateElementValue;
  argument?: AstNode;
  arguments?: AstNode[];
  async?: boolean;
  await?: boolean;
  body?: AstNode | AstNode[];
  callee?: AstNode;
  computed?: boolean;
  consequent?: AstNode[];
  expression?: AstNode;
  expressions?: AstNode[];
  id?: AstNode;
  imported?: AstNode;
  init?: AstNode;
  key?: AstNode;
  kind?: string;
  left?: AstNode;
  local?: AstNode;
  object?: AstNode;
  operator?: string;
  params?: AstNode[];
  parent?: AstNode;
  properties?: AstNode[];
  property?: AstNode;
  quasis?: AstNode[];
  range?: [number, number];
  right?: AstNode;
  source?: AstNode;
  specifiers?: AstNode[];
  static?: boolean;
  typeAnnotation?: AstNode;
  typeName?: AstNode;
};

type ScopeVariable = {
  name?: string;
  defs: { node: AstNode; type: string }[];
  references: {
    init?: boolean;
    isReadWrite: () => boolean;
    isWrite: () => boolean;
    writeExpr: AstNode | null;
  }[];
};

type Scope = {
  set: Map<string, ScopeVariable>;
  upper: Scope | null;
};

type RuleContext = {
  report: (input: {
    node: AstNode;
    messageId:
      | 'abortAfterSync'
      | 'alarmChangeInAlarm'
      | 'alarmChangeInAlarmThroughCall'
      | 'alarmChangeInConstructor'
      | 'alarmChangeInConstructorThroughCall'
      | 'asyncCallInTransactionSync'
      | 'asyncTransactionSync'
      | 'deferredWrite'
      | 'deferredWriteThroughCall'
      | 'delegateOnly'
      | 'deleteAllInTransaction'
      | 'deleteAllInTransactionThroughCall'
      | 'missingAlarm'
      | 'physicalAlarm'
      | 'physicalAlarmThroughCall'
      | 'nextOnce'
      | 'scheduleInConstructor'
      | 'tableCreation'
      | 'tableName';
    data?: Record<string, string>;
  }) => void;
  sourceCode: {
    getDeclaredVariables: (node: AstNode) => ScopeVariable[];
    getScope: (node: AstNode) => Scope;
  };
};

type FieldWrite = {
  safe: boolean;
  value: AstNode | undefined;
};

const bodyMembers = (node: AstNode | undefined): AstNode[] => {
  if (!node?.body || Array.isArray(node.body)) {
    return [];
  }

  return Array.isArray(node.body.body) ? node.body.body : [];
};

const isAstNode = (value: AstNode['value']): value is AstNode =>
  typeof value === 'object' && value !== null && 'type' in value;

const isTemplateElementValue = (
  value: AstNode['value']
): value is TemplateElementValue =>
  typeof value === 'object' && value !== null && !('type' in value);

const isStringLiteral = (node: AstNode): node is AstNode & { value: string } =>
  (node.type === 'Literal' || node.type === 'StringLiteral') &&
  typeof node.value === 'string';

const nodeValue = (value: AstNode['value']): AstNode | undefined =>
  isAstNode(value) ? value : undefined;

const propertyName = (node: AstNode | undefined) => {
  if (!node) {
    return undefined;
  }

  if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') {
    return node.name;
  }

  if (isStringLiteral(node)) {
    return node.value;
  }

  return undefined;
};

const resolveVariable = (context: RuleContext, node: AstNode | undefined) => {
  if (node?.type !== 'Identifier' || !node.name) {
    return undefined;
  }

  let scope: Scope | null = context.sourceCode.getScope(node);

  while (scope) {
    const variable = scope.set.get(node.name);

    if (variable) {
      return variable;
    }

    scope = scope.upper;
  }

  return undefined;
};

const enclosingClass = (node: AstNode) => {
  let current = node.parent;

  while (
    current &&
    current.type !== 'ClassDeclaration' &&
    current.type !== 'ClassExpression'
  ) {
    current = current.parent;
  }

  return current;
};

const durabilityConstructors = new Set([
  'Durability',
  'DurabilityAlarms',
  'DurabilityFanout',
  'DurabilityScheduler',
]);

/**
 * The name exported by `durability` that a `new` callee is bound to, so
 * `new Jobs()` after `import { Durability as Jobs }` and `new d.Durability()`
 * after `import * as d` both resolve to `Durability`.
 */
const durabilityImportName = (
  context: RuleContext,
  callee: AstNode
): string | undefined => {
  const namespaced = callee.type === 'MemberExpression';

  const variable = resolveVariable(
    context,
    namespaced ? callee.object : callee
  );

  const definition = variable?.defs[0];
  const source = propertyName(definition?.node.parent?.source) ?? '';

  if (
    definition?.type !== 'ImportBinding' ||
    (source !== 'durability' && !source.startsWith('durability/'))
  ) {
    return undefined;
  }

  if (namespaced) {
    return definition.node.type === 'ImportNamespaceSpecifier'
      ? propertyName(callee.property)
      : undefined;
  }

  return definition.node.type === 'ImportSpecifier'
    ? propertyName(definition.node.imported)
    : undefined;
};

// durabilityImportName only follows direct imports from durability, so a class
// imported through a local re-export falls back to its spelling.
const helperClassName = (context: RuleContext, node: AstNode | undefined) => {
  if (node?.type !== 'NewExpression' || !node.callee) {
    return undefined;
  }

  return (
    durabilityImportName(context, node.callee) ??
    (node.callee.type === 'Identifier' ? node.callee.name : undefined)
  );
};

/** Class fields holding a durability helper, by declared name. */
const durabilityFields = (
  context: RuleContext,
  members: AstNode[]
): Set<string> => {
  const fields = new Set<string>();

  for (const member of members) {
    if (member.type !== 'PropertyDefinition') {
      continue;
    }

    const name = propertyName(member.key);
    const value = nodeValue(member.value);
    const constructorName = helperClassName(context, value);
    const constructed = durabilityConstructors.has(constructorName ?? '');

    const created =
      value?.type === 'CallExpression' &&
      propertyName(value.callee) === 'createDurability';

    if (
      name !== undefined &&
      (name === 'durability' || constructed || created)
    ) {
      fields.add(name);
    }
  }

  return fields;
};

const isDurabilityAlarmCall = (
  node: AstNode | undefined,
  fields: Set<string>
) => {
  const value = node?.type === 'AwaitExpression' ? node.argument : node;

  if (value?.type !== 'CallExpression') {
    return false;
  }

  if (value.callee?.type !== 'MemberExpression') {
    return false;
  }

  if (propertyName(value.callee.property) !== 'alarm') {
    return false;
  }

  const receiver = value.callee.object;

  if (receiver?.type === 'Identifier') {
    return receiver.name === 'durability';
  }

  return (
    receiver?.type === 'MemberExpression' &&
    receiver.object?.type === 'ThisExpression' &&
    fields.has(propertyName(receiver.property) ?? '')
  );
};

const alarmRunnerRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      delegateOnly:
        'A durability alarm runner must only return the durability alarm handler, such as this.durability.alarm(alarmInfo).',
      missingAlarm:
        'A class using createDurability must delegate alarm() directly to durability.alarm(alarmInfo).',
      physicalAlarm:
        'A class using createDurability must schedule logical alarms through durability named alarms instead of calling setAlarm() or deleteAlarm().',
      physicalAlarmThroughCall:
        '{{function}}() calls setAlarm() or deleteAlarm(); a class using createDurability must schedule logical alarms through durability named alarms instead.',
    },
  },
  create(context: RuleContext) {
    const durabilityClasses = new WeakSet<AstNode>();
    const calledFunctions = createCalledFunctions(context);
    const calls: AstNode[] = [];

    const checkClass = (node: AstNode) => {
      const members = bodyMembers(node);

      const alarm = members.find(
        (member) =>
          member.type === 'MethodDefinition' &&
          propertyName(member.key) === 'alarm'
      );

      const fields = durabilityFields(context, members);
      const statements = bodyMembers(nodeValue(alarm?.value));

      const usesDurability =
        fields.size > 0 ||
        statements.some(
          (statement) =>
            statement.type === 'ReturnStatement' &&
            isDurabilityAlarmCall(statement.argument, fields)
        );

      if (!usesDurability) {
        return;
      }

      durabilityClasses.add(node);

      if (!alarm) {
        context.report({ node, messageId: 'missingAlarm' });

        return;
      }

      const statement = statements[0];

      const valid =
        statements.length === 1 &&
        statement?.type === 'ReturnStatement' &&
        isDurabilityAlarmCall(statement.argument, fields);

      if (!valid) {
        context.report({ node: alarm, messageId: 'delegateOnly' });
      }
    };

    return mergeVisitors(calledFunctions.visitors, {
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
      CallExpression(node: AstNode) {
        calls.push(node);
      },
      'Program:exit'() {
        for (const call of calls) {
          const classNode = enclosingClass(call);

          if (!classNode || !durabilityClasses.has(classNode)) {
            continue;
          }

          if (isAlarmChange(call)) {
            context.report({ node: call, messageId: 'physicalAlarm' });

            continue;
          }

          // Methods of the class are checked where they are written.
          const called = referencedFunction(context, call.callee);

          if (
            called &&
            !isAncestor(classNode, called) &&
            calledFunctions.reaches(call, isAlarmChange, 'written')
          ) {
            context.report({
              node: call,
              messageId: 'physicalAlarmThroughCall',
              data: { function: calleeName(call) },
            });
          }
        }
      },
    });
  },
};

const staticStringValue = (node: AstNode | undefined): string | undefined => {
  if (!node) {
    return undefined;
  }

  if (isStringLiteral(node)) {
    return node.value;
  }

  if (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSTypeAssertion'
  ) {
    return staticStringValue(node.expression);
  }

  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);

    return left === undefined || right === undefined ? undefined : left + right;
  }

  if (node.type !== 'TemplateLiteral') {
    return undefined;
  }

  const quasis = node.quasis ?? [];
  const expressions = node.expressions ?? [];

  if (quasis.length !== expressions.length + 1) {
    return undefined;
  }

  let value = '';

  for (let index = 0; index < quasis.length; index += 1) {
    const quasiValue = quasis[index]?.value;

    if (!isTemplateElementValue(quasiValue)) {
      return undefined;
    }

    const text = quasiValue.cooked ?? quasiValue.raw;

    if (text === undefined) {
      return undefined;
    }

    value += text;

    if (index < expressions.length) {
      const expression = staticStringValue(expressions[index]);

      if (expression === undefined) {
        return undefined;
      }

      value += expression;
    }
  }

  return value;
};

const transformNextOnceRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      nextOnce: 'A transform must not call next() more than once.',
    },
  },
  create(context: RuleContext) {
    const nextBindingRoots = new Map<ScopeVariable, ScopeVariable>();
    const contextBindingRoots = new Map<ScopeVariable, ScopeVariable>();
    const calledBindings = new Set<ScopeVariable>();

    const declaredVariable = (node: AstNode, name: string | undefined) =>
      context.sourceCode
        .getDeclaredVariables(node)
        .find(
          (candidate) =>
            candidate.name === name &&
            candidate.defs.some((definition) => definition.type === 'Parameter')
        );

    const isInlineTransformHandler = (node: AstNode) => {
      const parent = node.parent;
      let factory: AstNode | undefined;

      if (
        parent?.type === 'ArrowFunctionExpression' ||
        parent?.type === 'FunctionExpression'
      ) {
        factory = parent;
      } else {
        const candidate = parent?.parent?.parent;

        if (
          parent?.type === 'ReturnStatement' &&
          parent.parent?.type === 'BlockStatement' &&
          (candidate?.type === 'ArrowFunctionExpression' ||
            candidate?.type === 'FunctionExpression')
        ) {
          factory = candidate;
        }
      }

      if (!factory) {
        return false;
      }

      const call = factory.parent;

      return (
        call?.type === 'CallExpression' &&
        call.arguments?.includes(factory) === true &&
        call.callee?.type === 'MemberExpression' &&
        (propertyName(call.callee.property) === 'caller' ||
          propertyName(call.callee.property) === 'callee')
      );
    };

    const registerNextBinding = (node: AstNode) => {
      const parameter = node.params?.[0];

      const pattern =
        parameter?.type === 'AssignmentPattern' ? parameter.left : parameter;

      if (pattern?.type === 'Identifier') {
        const variable = isInlineTransformHandler(node)
          ? declaredVariable(node, pattern.name)
          : undefined;

        if (variable) {
          contextBindingRoots.set(variable, variable);
        }

        return;
      }

      if (pattern?.type !== 'ObjectPattern') {
        return;
      }

      const nextProperty = pattern.properties?.find(
        (property) =>
          property.type === 'Property' && propertyName(property.key) === 'next'
      );

      const value = nodeValue(nextProperty?.value);
      const binding = value?.type === 'AssignmentPattern' ? value.left : value;

      if (binding?.type !== 'Identifier') {
        return;
      }

      const variable = declaredVariable(node, binding.name);

      if (variable) {
        nextBindingRoots.set(variable, variable);
      }
    };

    const nextBindingRoot = (node: AstNode | undefined) => {
      const directBinding = resolveVariable(context, node);

      if (directBinding) {
        return nextBindingRoots.get(directBinding);
      }

      if (
        node?.type !== 'MemberExpression' ||
        propertyName(node.property) !== 'next'
      ) {
        return undefined;
      }

      const contextBinding = resolveVariable(context, node.object);

      return contextBinding
        ? contextBindingRoots.get(contextBinding)
        : undefined;
    };

    return {
      ArrowFunctionExpression: registerNextBinding,
      FunctionDeclaration: registerNextBinding,
      FunctionExpression: registerNextBinding,
      VariableDeclarator(node: AstNode) {
        if (node.id?.type !== 'Identifier') {
          return;
        }

        const root = nextBindingRoot(node.init);

        const alias = context.sourceCode
          .getDeclaredVariables(node)
          .find((variable) => variable.name === node.id?.name);

        if (root && alias) {
          nextBindingRoots.set(alias, root);
        }
      },
      CallExpression(node: AstNode) {
        const root = nextBindingRoot(node.callee);

        if (!root) {
          return;
        }

        if (calledBindings.has(root)) {
          context.report({ node, messageId: 'nextOnce' });

          return;
        }

        calledBindings.add(root);
      },
    };
  },
};

const durabilityMigrationsRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      tableCreation:
        'CREATE TABLE statements must be declared in DurableMigrations.',
      tableName:
        'workers-qb migrations must use the durability_migrations table.',
    },
  },
  create(context: RuleContext) {
    const durableMigrationTypes = new Set<ScopeVariable>();
    const durableMigrationRanges: [number, number][] = [];
    const queryBuilderConstructors = new Set<ScopeVariable>();
    const migrationCalls: AstNode[] = [];
    const fieldWrites = new WeakMap<AstNode, Map<string, FieldWrite[]>>();

    const classForThis = (node: AstNode) => {
      let current = node.parent;

      while (current) {
        if (
          current.type === 'ClassDeclaration' ||
          current.type === 'ClassExpression'
        ) {
          return current;
        }

        if (
          current.type === 'FunctionDeclaration' ||
          current.type === 'FunctionExpression'
        ) {
          const method = current.parent;

          if (
            method?.type !== 'MethodDefinition' ||
            nodeValue(method.value) !== current ||
            method.static
          ) {
            return undefined;
          }
        }

        current = current.parent;
      }

      return undefined;
    };

    const isQueryBuilder = (
      node: AstNode | undefined,
      seenVariables = new Set<ScopeVariable>()
    ): boolean => {
      if (!node) {
        return false;
      }

      if (node.type === 'NewExpression') {
        const constructor = resolveVariable(context, node.callee);

        if (constructor && queryBuilderConstructors.has(constructor)) {
          return true;
        }
      }

      if (node.type === 'Identifier') {
        const variable = resolveVariable(context, node);

        if (!variable || seenVariables.has(variable)) {
          return false;
        }

        const definitions = variable.defs.filter(
          (definition) => definition.type === 'Variable'
        );

        if (definitions.length !== 1 || variable.defs.length !== 1) {
          return false;
        }

        const declarator = definitions[0]?.node;
        const sources: AstNode[] = [];

        if (declarator?.init) {
          sources.push(declarator.init);
        }

        for (const reference of variable.references) {
          if (!reference.isWrite() || reference.init) {
            continue;
          }

          if (reference.isReadWrite() || !reference.writeExpr) {
            return false;
          }

          sources.push(reference.writeExpr);
        }

        if (sources.length === 0) {
          return false;
        }

        const nextSeen = new Set(seenVariables);
        nextSeen.add(variable);

        return sources.every((source) => isQueryBuilder(source, nextSeen));
      }

      if (
        node.type !== 'MemberExpression' ||
        node.object?.type !== 'ThisExpression'
      ) {
        return false;
      }

      const name = propertyName(node.property);
      const classNode = name ? classForThis(node.object) : undefined;

      if (!name || !classNode) {
        return false;
      }

      const definitions = bodyMembers(classNode).filter(
        (member) =>
          member.type === 'PropertyDefinition' &&
          !member.static &&
          propertyName(member.key) === name
      );

      if (definitions.length > 1) {
        return false;
      }

      const sources: AstNode[] = [];
      const initializer = nodeValue(definitions[0]?.value);

      if (initializer) {
        sources.push(initializer);
      }

      for (const write of fieldWrites.get(classNode)?.get(name) ?? []) {
        if (!write.safe || !write.value) {
          return false;
        }

        sources.push(write.value);
      }

      return (
        sources.length > 0 &&
        sources.every((source) => isQueryBuilder(source, seenVariables))
      );
    };

    const checkStaticExpression = (node: AstNode) => {
      const value = staticStringValue(node);

      if (
        value === undefined ||
        !/\bCREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?TABLE\b/i.test(value)
      ) {
        return;
      }

      const parentValue = staticStringValue(node.parent);

      if (
        parentValue !== undefined &&
        (node.parent?.type === 'BinaryExpression' ||
          node.parent?.type === 'TemplateLiteral' ||
          node.parent?.type === 'ParenthesizedExpression')
      ) {
        return;
      }

      const range = node.range;

      const insideDurableMigrations =
        range !== undefined &&
        durableMigrationRanges.some(
          ([start, end]) => start <= range[0] && range[1] <= end
        );

      if (!insideDurableMigrations) {
        context.report({ node, messageId: 'tableCreation' });
      }
    };

    return {
      ImportDeclaration(node: AstNode) {
        const source = propertyName(node.source);

        for (const specifier of node.specifiers ?? []) {
          if (specifier.type !== 'ImportSpecifier') {
            continue;
          }

          const importedName = propertyName(specifier.imported);
          const variables = context.sourceCode.getDeclaredVariables(specifier);

          if (source === 'workers-qb' && importedName === 'DOQB') {
            for (const variable of variables) {
              queryBuilderConstructors.add(variable);
            }
          }

          if (
            (source === '@durability/storage' || source === 'durability') &&
            importedName === 'DurableMigrations'
          ) {
            for (const variable of variables) {
              durableMigrationTypes.add(variable);
            }
          }
        }
      },
      VariableDeclarator(node: AstNode) {
        const satisfiesType =
          node.init?.type === 'TSSatisfiesExpression'
            ? resolveVariable(context, node.init.typeAnnotation?.typeName)
            : undefined;

        const declaredType = resolveVariable(
          context,
          node.id?.typeAnnotation?.typeAnnotation?.typeName
        );

        if (
          node.init?.range &&
          ((satisfiesType && durableMigrationTypes.has(satisfiesType)) ||
            (declaredType && durableMigrationTypes.has(declaredType)))
        ) {
          durableMigrationRanges.push(node.init.range);
        }
      },
      AssignmentExpression(node: AstNode) {
        if (
          node.left?.type !== 'MemberExpression' ||
          node.left.object?.type !== 'ThisExpression'
        ) {
          return;
        }

        const name = propertyName(node.left.property);
        const classNode = name ? classForThis(node.left.object) : undefined;

        if (!name || !classNode) {
          return;
        }

        let current = node.parent;
        let method: AstNode | undefined;

        while (current && current !== classNode) {
          if (
            current.type === 'FunctionDeclaration' ||
            current.type === 'FunctionExpression' ||
            current.type === 'ArrowFunctionExpression'
          ) {
            const parent = current.parent;

            if (
              current.type === 'FunctionExpression' &&
              parent?.type === 'MethodDefinition' &&
              nodeValue(parent.value) === current
            ) {
              method = parent;
            }

            break;
          }

          current = current.parent;
        }

        let classFieldWrites = fieldWrites.get(classNode);

        if (!classFieldWrites) {
          classFieldWrites = new Map();
          fieldWrites.set(classNode, classFieldWrites);
        }

        const writes = classFieldWrites.get(name) ?? [];
        writes.push({
          safe:
            node.operator === '=' &&
            method?.kind === 'constructor' &&
            !method.static,
          value: node.right,
        });
        classFieldWrites.set(name, writes);
      },
      Literal: checkStaticExpression,
      TemplateLiteral: checkStaticExpression,
      BinaryExpression: checkStaticExpression,
      ParenthesizedExpression: checkStaticExpression,
      CallExpression(node: AstNode) {
        if (
          node.callee?.type === 'MemberExpression' &&
          propertyName(node.callee.property) === 'migrations'
        ) {
          migrationCalls.push(node);
        }
      },
      'Program:exit'() {
        for (const node of migrationCalls) {
          if (node.callee?.type !== 'MemberExpression') {
            continue;
          }

          if (!isQueryBuilder(node.callee.object)) {
            continue;
          }

          const options = node.arguments?.[0];

          const tableName =
            options?.type === 'ObjectExpression'
              ? options.properties?.find(
                  (property) =>
                    property.type === 'Property' &&
                    propertyName(property.key) === 'tableName'
                )
              : undefined;

          if (
            !tableName ||
            propertyName(nodeValue(tableName.value)) !== 'durability_migrations'
          ) {
            context.report({ node, messageId: 'tableName' });
          }
        }
      },
    };
  },
};

const durableObjectStateNames = new Set(['ctx', 'state']);

/**
 * `this.ctx` or `state` as a dotted path, so the receivers of `sync()` and
 * `abort()` can be compared. Computed and call-based receivers have no path.
 */
const receiverPath = (node: AstNode | undefined): string | undefined => {
  if (node?.type === 'ThisExpression') {
    return 'this';
  }

  if (node?.type === 'Identifier') {
    return node.name;
  }

  if (node?.type !== 'MemberExpression' || node.computed) {
    return undefined;
  }

  const object = receiverPath(node.object);
  const property = propertyName(node.property);

  return object === undefined || property === undefined
    ? undefined
    : `${object}.${property}`;
};

const statementList = (node: AstNode | undefined): AstNode[] => {
  if (node?.type === 'SwitchCase') {
    return node.consequent ?? [];
  }

  return Array.isArray(node?.body) ? node.body : [];
};

/**
 * Whether `statement` awaits `<state>.storage.sync()`, or awaits a function
 * whose last statement does, however deeply.
 */
const awaitsStorageSync = (
  context: RuleContext,
  statement: AstNode | undefined,
  state: string,
  visited = new Set<AstNode>()
): boolean => {
  const awaited =
    statement?.type === 'ExpressionStatement' &&
    statement.expression?.type === 'AwaitExpression'
      ? statement.expression.argument
      : undefined;

  if (awaited?.type !== 'CallExpression') {
    return false;
  }

  const syncs =
    awaited.callee?.type === 'MemberExpression' &&
    propertyName(awaited.callee.property) === 'sync' &&
    receiverPath(awaited.callee.object) === `${state}.storage`;

  if (syncs) {
    return true;
  }

  const called = referencedFunction(context, awaited.callee);
  const body = called?.body;

  if (
    !called ||
    Array.isArray(body) ||
    body?.type !== 'BlockStatement' ||
    visited.has(called)
  ) {
    return false;
  }

  visited.add(called);

  const statements = statementList(body);
  const last = statements[statements.length - 1];

  return awaitsStorageSync(context, last, state, visited);
};

const abortAfterSyncRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      abortAfterSync:
        'ctx.abort() discards storage writes that have not been flushed, including awaited put() calls; the statement directly before it must be await ctx.storage.sync().',
    },
  },
  create(context: RuleContext) {
    return {
      CallExpression(node: AstNode) {
        if (
          node.callee?.type !== 'MemberExpression' ||
          propertyName(node.callee.property) !== 'abort'
        ) {
          return;
        }

        const receiver = node.callee.object;

        const stateName =
          receiver?.type === 'MemberExpression'
            ? propertyName(receiver.property)
            : receiver?.name;

        const state = receiverPath(receiver);

        if (!state || !durableObjectStateNames.has(stateName ?? '')) {
          return;
        }

        const statement = node.parent;
        const statements = statementList(statement?.parent);
        const index = statement ? statements.indexOf(statement) : -1;

        const synced =
          statement?.type === 'ExpressionStatement' &&
          index > 0 &&
          awaitsStorageSync(context, statements[index - 1], state);

        if (!synced) {
          context.report({ node, messageId: 'abortAfterSync' });
        }
      },
    };
  },
};

const transactionSyncCallbackRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      asyncTransactionSync:
        'transactionSync() commits when its callback returns; an async callback commits the writes before its first await and runs the rest outside the transaction, and its errors do not roll anything back.',
      asyncCallInTransactionSync:
        '{{function}}() leads to an async function that writes to storage after an await. transactionSync() commits when its callback returns, so those writes run outside the transaction, and their errors do not roll anything back.',
    },
  },
  create(context: RuleContext) {
    const calledFunctions = createCalledFunctions(context);
    const callbacks: AstNode[] = [];

    const writesAfterAwait = (call: AstNode) => {
      const called = referencedFunction(context, call.callee);

      return called !== undefined && calledFunctions.writesAfterAwait(called);
    };

    return mergeVisitors(calledFunctions.visitors, {
      CallExpression(node: AstNode) {
        if (
          node.callee?.type !== 'MemberExpression' ||
          calleeName(node) !== 'transactionSync'
        ) {
          return;
        }

        const argument = node.arguments?.[0];

        const callback =
          argument && functionTypes.has(argument.type)
            ? argument
            : referencedFunction(context, argument);

        if (callback?.async) {
          context.report({
            node: argument ?? node,
            messageId: 'asyncTransactionSync',
          });
        } else if (callback) {
          callbacks.push(callback);
        }
      },
      'Program:exit'() {
        for (const callback of callbacks) {
          for (const call of calledFunctions.callsWhenRun(callback)) {
            const reachesWrite =
              writesAfterAwait(call) ||
              calledFunctions.reaches(call, writesAfterAwait, 'run');

            if (reachesWrite) {
              context.report({
                node: call,
                messageId: 'asyncCallInTransactionSync',
                data: { function: calleeName(call) },
              });
            }
          }
        }
      },
    });
  },
};

const functionTypes = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

const transparentWrappers = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

const promiseCallbackMethods = new Set(['catch', 'finally', 'then']);
const timerFunctions = new Set(['setInterval', 'setTimeout']);

const storageMethods = new Set([
  'delete',
  'deleteAlarm',
  'deleteAll',
  'put',
  'setAlarm',
  'transaction',
  'transactionSync',
]);

const endsWithSegment = (path: string, suffix: string) =>
  path === suffix || path.endsWith(`.${suffix}`);

const isStorageWrite = (node: AstNode) => {
  if (node.callee?.type !== 'MemberExpression') {
    return false;
  }

  const method = propertyName(node.callee.property) ?? '';
  const receiver = receiverPath(node.callee.object) ?? '';

  if (endsWithSegment(receiver, 'storage')) {
    return storageMethods.has(method);
  }

  if (endsWithSegment(receiver, 'storage.kv')) {
    return method === 'put' || method === 'delete';
  }

  if (!endsWithSegment(receiver, 'storage.sql') || method !== 'exec') {
    return false;
  }

  const query = staticStringValue(node.arguments?.[0]);

  return query === undefined || !/^\s*SELECT\b/i.test(query);
};

const enclosingFunction = (node: AstNode) => {
  let current = node.parent;

  while (current && !functionTypes.has(current.type)) {
    current = current.parent;
  }

  return current;
};

const isAncestor = (ancestor: AstNode, node: AstNode) => {
  let current = node.parent;

  while (current) {
    if (current === ancestor) {
      return true;
    }

    current = current.parent;
  }

  return false;
};

/**
 * Whether the promise produced by `node` is dropped instead of awaited or
 * returned: discarded with `void`, left as a statement, or handed to
 * `waitUntil()`, so the response can be sent before the work finishes.
 * `.then()`, `.catch()` and `.finally()` chained onto it are followed.
 */
const isDetached = (node: AstNode): boolean => {
  let current = node;

  while (current.parent) {
    const parent: AstNode = current.parent;

    if (transparentWrappers.has(parent.type)) {
      current = parent;
      continue;
    }

    const chained =
      parent.type === 'MemberExpression' &&
      parent.object === current &&
      promiseCallbackMethods.has(propertyName(parent.property) ?? '') &&
      parent.parent?.type === 'CallExpression' &&
      parent.parent.callee === parent;

    if (!chained) {
      break;
    }

    current = parent.parent ?? parent;
  }

  const parent = current.parent;

  if (parent?.type === 'UnaryExpression' && parent.operator === 'void') {
    return true;
  }

  if (parent?.type === 'ExpressionStatement') {
    return true;
  }

  return (
    parent?.type === 'CallExpression' &&
    parent.callee?.type === 'MemberExpression' &&
    propertyName(parent.callee.property) === 'waitUntil' &&
    parent.arguments?.includes(current) === true
  );
};

const unwrappedParent = (node: AstNode) => {
  let current = node;

  while (current.parent && transparentWrappers.has(current.parent.type)) {
    current = current.parent;
  }

  return { child: current, parent: current.parent };
};

const calleeName = (call: AstNode) =>
  propertyName(
    call.callee?.type === 'MemberExpression'
      ? call.callee.property
      : call.callee
  ) ?? '';

const runsImmediately = (fn: AstNode) => {
  const { child, parent } = unwrappedParent(fn);

  if (parent?.type !== 'CallExpression') {
    return false;
  }

  if (parent.callee === child) {
    return true;
  }

  const name = calleeName(parent);

  return (
    parent.arguments?.includes(child) === true &&
    (name === 'blockConcurrencyWhile' || promiseCallbackMethods.has(name))
  );
};

const classMethodCache = new WeakMap<AstNode, Map<string, AstNode>>();

/** Non-static methods and function-valued fields of a class, by name. */
const classMethods = (classNode: AstNode) => {
  const cached = classMethodCache.get(classNode);

  if (cached) {
    return cached;
  }

  const methods = new Map<string, AstNode>();

  for (const member of bodyMembers(classNode)) {
    const name = propertyName(member.key);
    const value = nodeValue(member.value);

    const isMethod =
      (member.type === 'MethodDefinition' && member.kind === 'method') ||
      (member.type === 'PropertyDefinition' &&
        value !== undefined &&
        functionTypes.has(value.type));

    if (isMethod && !member.static && name !== undefined && value) {
      methods.set(name, value);
    }
  }

  classMethodCache.set(classNode, methods);

  return methods;
};

/** Whether `this` at `node` is the instance of its enclosing class. */
const thisIsInstance = (node: AstNode) => {
  let current = node.parent;

  while (current) {
    if (
      current.type === 'MethodDefinition' ||
      current.type === 'PropertyDefinition'
    ) {
      return current.static !== true;
    }

    const hasOwnThis =
      current.type === 'StaticBlock' ||
      current.type === 'FunctionDeclaration' ||
      (current.type === 'FunctionExpression' &&
        current.parent?.type !== 'MethodDefinition' &&
        current.parent?.type !== 'PropertyDefinition');

    if (hasOwnThis) {
      return false;
    }

    current = current.parent;
  }

  return false;
};

/**
 * The function `node` refers to: a method of the enclosing class read
 * through `this`, or a function declared in the same file.
 */
const referencedFunction = (
  context: RuleContext,
  node: AstNode | undefined
): AstNode | undefined => {
  if (
    node?.type === 'MemberExpression' &&
    node.object?.type === 'ThisExpression'
  ) {
    const classNode = enclosingClass(node);
    const name = node.computed ? undefined : propertyName(node.property);

    return classNode && name !== undefined && thisIsInstance(node)
      ? classMethods(classNode).get(name)
      : undefined;
  }

  const definition = resolveVariable(context, node)?.defs[0];

  if (definition?.node.type === 'FunctionDeclaration') {
    return definition.node;
  }

  const init =
    definition?.type === 'Variable' ? definition.node.init : undefined;

  return init && functionTypes.has(init.type) ? init : undefined;
};

type FunctionScope = 'run' | 'written';

/**
 * Indexes the calls and awaits in each function of a file, so a rule can
 * follow a call into the function it calls and on through the functions that
 * one calls. A function's `run` calls are those it makes when it runs,
 * including in callbacks it runs in place; its `written` calls are every call
 * written inside it, including in callbacks that run later.
 */
const createCalledFunctions = (context: RuleContext) => {
  const runCalls = new Map<AstNode, AstNode[]>();
  const writtenCalls = new Map<AstNode, AstNode[]>();
  const awaits = new Map<AstNode, AstNode[]>();

  const add = (
    index: Map<AstNode, AstNode[]>,
    owner: AstNode,
    node: AstNode
  ) => {
    const nodes = index.get(owner) ?? [];
    nodes.push(node);
    index.set(owner, nodes);
  };

  const recordCall = (call: AstNode) => {
    let owner = enclosingFunction(call);
    let runsWithOwner = true;

    while (owner) {
      add(writtenCalls, owner, call);

      if (runsWithOwner) {
        add(runCalls, owner, call);
      }

      runsWithOwner = runsWithOwner && runsImmediately(owner);
      owner = enclosingFunction(owner);
    }
  };

  const recordAwait = (node: AstNode) => {
    const owner = enclosingFunction(node);

    if (owner) {
      add(awaits, owner, node);
    }
  };

  const awaitsBefore = (owner: AstNode, node: AstNode) =>
    (awaits.get(owner) ?? []).some(
      (awaited) =>
        !isAncestor(awaited, node) &&
        (awaited.range?.[1] ?? Infinity) <= (node.range?.[1] ?? 0)
    );

  const callsWhenRun = (fn: AstNode) => runCalls.get(fn) ?? [];

  /**
   * Whether `call` leads to a call matching `matches`, in the function it
   * calls or in any function reached from that one.
   */
  const reaches = (
    call: AstNode,
    matches: (call: AstNode) => boolean,
    scope: FunctionScope,
    visited = new Set<AstNode>()
  ): boolean => {
    const called = referencedFunction(context, call.callee);

    if (!called || visited.has(called)) {
      return false;
    }

    visited.add(called);

    const calls = (scope === 'run' ? runCalls : writtenCalls).get(called) ?? [];

    return calls.some(
      (inner) => matches(inner) || reaches(inner, matches, scope, visited)
    );
  };

  /**
   * Whether an async function writes to storage after its first await, itself
   * or through the functions it calls from there.
   */
  const writesAfterAwait = (fn: AstNode) =>
    fn.async === true &&
    callsWhenRun(fn).some(
      (call) =>
        awaitsBefore(fn, call) &&
        (isStorageWrite(call) || reaches(call, isStorageWrite, 'run'))
    );

  return {
    awaitsBefore,
    callsWhenRun,
    reaches,
    writesAfterAwait,
    visitors: {
      AwaitExpression: recordAwait,
      CallExpression: recordCall,
      ForOfStatement(node: AstNode) {
        if (node.await) {
          recordAwait(node);
        }
      },
    },
  };
};

type Visitors = Record<string, (node: AstNode) => void>;

/** Combines visitors so several can handle the same node type. */
const mergeVisitors = (...visitorSets: Visitors[]) => {
  const merged: Visitors = {};

  for (const visitors of visitorSets) {
    for (const [type, visit] of Object.entries(visitors)) {
      const previous = merged[type];

      merged[type] = previous
        ? (node) => {
            previous(node);
            visit(node);
          }
        : visit;
    }
  }

  return merged;
};

const isAlarmChange = (call: AstNode) => {
  const method = calleeName(call);

  return (
    call.callee?.type === 'MemberExpression' &&
    (method === 'setAlarm' || method === 'deleteAlarm')
  );
};

const deferredStorageWritesRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      deferredWrite:
        'This storage write starts after the request can respond, so the output gate does not hold the response for it and the write is lost if the object resets first. Await the work, or persist it before responding and finish it from an alarm.',
      deferredWriteThroughCall:
        '{{function}}() makes a storage write that starts after the request can respond, so the output gate does not hold the response for it and the write is lost if the object resets first. Await the work, or persist it before responding and finish it from an alarm.',
    },
  },
  create(context: RuleContext) {
    const calledFunctions = createCalledFunctions(context);
    const { awaitsBefore } = calledFunctions;
    const writes: AstNode[] = [];
    const calls: AstNode[] = [];

    const runsLater = (owner: AstNode, write: AstNode) => {
      const { child, parent } = unwrappedParent(owner);

      if (parent?.type !== 'CallExpression') {
        return false;
      }

      if (parent.arguments?.includes(child)) {
        const name = calleeName(parent);

        if (timerFunctions.has(name)) {
          return true;
        }

        return promiseCallbackMethods.has(name) && isDetached(parent);
      }

      return (
        parent.callee === child &&
        owner.async === true &&
        isDetached(parent) &&
        awaitsBefore(owner, write)
      );
    };

    const isDeferred = (node: AstNode) => {
      let owner = enclosingFunction(node);

      while (owner && !runsLater(owner, node)) {
        owner = enclosingFunction(owner);
      }

      return Boolean(owner);
    };

    /**
     * A call that writes later through the function it calls: from deferred
     * work, or a dropped call to an async function that writes after an await.
     */
    const writesLaterThroughCall = (call: AstNode) => {
      const called = referencedFunction(context, call.callee);

      if (!called) {
        return false;
      }

      if (isDetached(call) && calledFunctions.writesAfterAwait(called)) {
        return true;
      }

      return (
        isDeferred(call) && calledFunctions.reaches(call, isStorageWrite, 'run')
      );
    };

    return mergeVisitors(calledFunctions.visitors, {
      CallExpression(node: AstNode) {
        if (isStorageWrite(node)) {
          writes.push(node);
        } else {
          calls.push(node);
        }
      },
      'Program:exit'() {
        for (const write of writes) {
          if (isDeferred(write)) {
            context.report({ node: write, messageId: 'deferredWrite' });
          }
        }

        for (const call of calls) {
          if (writesLaterThroughCall(call)) {
            context.report({
              node: call,
              messageId: 'deferredWriteThroughCall',
              data: { function: calleeName(call) },
            });
          }
        }
      },
    });
  },
};

const alarmHandlerRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      alarmChangeInAlarm:
        'Calling setAlarm() or deleteAlarm() inside alarm() replaces the retry of a failed run: an error after it is never retried, or is rerun with no backoff and no retry limit. Schedule follow-up work through durability instead.',
      alarmChangeInAlarmThroughCall:
        '{{function}}() calls setAlarm() or deleteAlarm(), which inside alarm() replaces the retry of a failed run: an error after it is never retried, or is rerun with no backoff and no retry limit. Schedule follow-up work through durability instead.',
    },
  },
  create(context: RuleContext) {
    const calledFunctions = createCalledFunctions(context);
    const calls: AstNode[] = [];

    return mergeVisitors(calledFunctions.visitors, {
      CallExpression(node: AstNode) {
        let member = node.parent;

        while (
          member &&
          member.type !== 'MethodDefinition' &&
          member.type !== 'PropertyDefinition'
        ) {
          member = member.parent;
        }

        if (member?.static || propertyName(member?.key) !== 'alarm') {
          return;
        }

        if (isAlarmChange(node)) {
          context.report({ node, messageId: 'alarmChangeInAlarm' });
        } else {
          calls.push(node);
        }
      },
      'Program:exit'() {
        for (const call of calls) {
          if (calledFunctions.reaches(call, isAlarmChange, 'written')) {
            context.report({
              node: call,
              messageId: 'alarmChangeInAlarmThroughCall',
              data: { function: calleeName(call) },
            });
          }
        }
      },
    });
  },
};

/**
 * Methods of each durability helper that schedule work, and so set or move the
 * object's alarm. Methods of `Durability` and `DurabilityAlarms` are named
 * after the application's handlers, so all of theirs except `lifecycle` count.
 */
const schedulingMethods = new Map([
  ['DurabilityFanout', new Set(['alarm', 'enqueue'])],
  ['DurabilityOutbox', new Set(['alarm', 'stage'])],
  ['DurabilitySchedule', new Set(['alarm', 'cancel', 'reschedule', 'set'])],
  ['DurabilityScheduler', new Set(['alarm'])],
  ['DurabilitySemaphore', new Set(['alarm', 'handle'])],
  [
    'DurabilitySemaphoreQueue',
    new Set(['alarm', 'cancel', 'enqueue', 'release']),
  ],
  ['DurabilityTopology', new Set(['alarm', 'delete', 'update'])],
]);

const classesWithHandlerMethods = new Set(['Durability', 'DurabilityAlarms']);

const runsDuringConstruction = (node: AstNode) => {
  let current = node.parent;

  while (current) {
    if (current.type === 'PropertyDefinition') {
      return current.static !== true;
    }

    if (functionTypes.has(current.type)) {
      if (current.parent?.type === 'MethodDefinition') {
        return current.parent.kind === 'constructor';
      }

      if (!runsImmediately(current)) {
        return false;
      }
    }

    current = current.parent;
  }

  return false;
};

const alarmConstructorRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      alarmChangeInConstructor:
        'The constructor runs every time the object is loaded, including to deliver an alarm. A Durable Object has one alarm, so setAlarm() or deleteAlarm() here replaces or removes the pending alarm, such as a retry or work durability scheduled, on every load. Change the alarm from the request that needs it.',
      scheduleInConstructor:
        "The constructor runs every time the object is loaded, including to deliver an alarm, so this durability call schedules its work again on every load: it moves the object's alarm, and a named alarm or schedule set here replaces its pending occurrence each time. Schedule from the request that creates the work.",
      alarmChangeInConstructorThroughCall:
        "{{function}}() changes the object's alarm or schedules durability work, and the constructor runs every time the object is loaded, including to deliver an alarm, so it replaces the pending alarm on every load. Call it from the request that creates the work.",
    },
  },
  create(context: RuleContext) {
    const calledFunctions = createCalledFunctions(context);
    const helperFields = new Map<AstNode, Map<string, string>>();
    const calls: AstNode[] = [];

    const recordField = (
      classNode: AstNode | undefined,
      field: string | undefined,
      helperClass: string | undefined
    ) => {
      if (!classNode || field === undefined || helperClass === undefined) {
        return;
      }

      const fields = helperFields.get(classNode) ?? new Map<string, string>();
      fields.set(field, helperClass);
      helperFields.set(classNode, fields);
    };

    const helperClassOf = (receiver: AstNode | undefined) => {
      if (
        receiver?.type === 'MemberExpression' &&
        receiver.object?.type === 'ThisExpression'
      ) {
        const classNode = enclosingClass(receiver);
        const field = propertyName(receiver.property) ?? '';

        return classNode && helperFields.get(classNode)?.get(field);
      }

      const definition = resolveVariable(context, receiver)?.defs[0];

      return definition?.type === 'Variable'
        ? helperClassName(context, definition.node.init)
        : undefined;
    };

    const schedules = (callee: AstNode, method: string) => {
      const helperClass = helperClassOf(callee.object);

      if (helperClass) {
        return classesWithHandlerMethods.has(helperClass)
          ? method !== 'lifecycle'
          : schedulingMethods.get(helperClass)?.has(method) === true;
      }

      return (
        method === 'cancel' &&
        callee.object?.type === 'MemberExpression' &&
        helperClassOf(callee.object.object) === 'DurabilityAlarms'
      );
    };

    const alarmChangeMessage = (call: AstNode) => {
      if (isAlarmChange(call)) {
        return 'alarmChangeInConstructor';
      }

      const callee = call.callee;

      return callee?.type === 'MemberExpression' &&
        schedules(callee, propertyName(callee.property) ?? '')
        ? 'scheduleInConstructor'
        : undefined;
    };

    const changesAlarm = (call: AstNode) =>
      alarmChangeMessage(call) !== undefined;

    return mergeVisitors(calledFunctions.visitors, {
      PropertyDefinition(node: AstNode) {
        recordField(
          enclosingClass(node),
          propertyName(node.key),
          helperClassName(context, nodeValue(node.value))
        );
      },
      AssignmentExpression(node: AstNode) {
        if (
          node.left?.type !== 'MemberExpression' ||
          node.left.object?.type !== 'ThisExpression'
        ) {
          return;
        }

        recordField(
          enclosingClass(node),
          propertyName(node.left.property),
          helperClassName(context, node.right)
        );
      },
      CallExpression(node: AstNode) {
        if (runsDuringConstruction(node)) {
          calls.push(node);
        }
      },
      'Program:exit'() {
        for (const call of calls) {
          const messageId = alarmChangeMessage(call);

          if (messageId) {
            context.report({ node: call, messageId });

            continue;
          }

          if (calledFunctions.reaches(call, changesAlarm, 'run')) {
            context.report({
              node: call,
              messageId: 'alarmChangeInConstructorThroughCall',
              data: { function: calleeName(call) },
            });
          }
        }
      },
    });
  },
};

const transactionMethods = new Set(['transaction', 'transactionSync']);

const insideTransactionCallback = (node: AstNode) => {
  let owner = enclosingFunction(node);

  while (owner) {
    const { child, parent } = unwrappedParent(owner);

    const transactionCallback =
      parent?.type === 'CallExpression' &&
      parent.arguments?.[0] === child &&
      parent.callee?.type === 'MemberExpression' &&
      transactionMethods.has(propertyName(parent.callee.property) ?? '');

    if (transactionCallback) {
      return true;
    }

    owner = enclosingFunction(owner);
  }

  return false;
};

const isDeleteAll = (call: AstNode) =>
  call.callee?.type === 'MemberExpression' &&
  propertyName(call.callee.property) === 'deleteAll';

const deleteAllInTransactionRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      deleteAllInTransaction:
        'deleteAll() cannot run inside a transaction: transaction() rejects it, and transactionSync() applies it immediately outside the transaction, so a later error does not roll it back. Call deleteAll() before or after the transaction.',
      deleteAllInTransactionThroughCall:
        '{{function}}() calls deleteAll(), which cannot run inside a transaction: transaction() rejects it, and transactionSync() applies it immediately outside the transaction, so a later error does not roll it back. Call it before or after the transaction.',
    },
  },
  create(context: RuleContext) {
    const calledFunctions = createCalledFunctions(context);
    const calls: AstNode[] = [];

    return mergeVisitors(calledFunctions.visitors, {
      CallExpression(node: AstNode) {
        if (!insideTransactionCallback(node)) {
          return;
        }

        if (isDeleteAll(node)) {
          context.report({ node, messageId: 'deleteAllInTransaction' });
        } else {
          calls.push(node);
        }
      },
      'Program:exit'() {
        for (const call of calls) {
          if (calledFunctions.reaches(call, isDeleteAll, 'written')) {
            context.report({
              node: call,
              messageId: 'deleteAllInTransactionThroughCall',
              data: { function: calleeName(call) },
            });
          }
        }
      },
    });
  },
};

export default {
  meta: { name: 'durability' },
  rules: {
    'abort-after-sync': abortAfterSyncRule,
    'alarm-runner-only': alarmRunnerRule,
    'no-alarm-changes-in-alarm-handler': alarmHandlerRule,
    'no-alarm-changes-in-constructor': alarmConstructorRule,
    'durability-migrations-only': durabilityMigrationsRule,
    'no-delete-all-in-transaction': deleteAllInTransactionRule,
    'no-deferred-storage-writes': deferredStorageWritesRule,
    'transaction-sync-callback': transactionSyncCallbackRule,
    'transform-next-once': transformNextOnceRule,
  },
};
