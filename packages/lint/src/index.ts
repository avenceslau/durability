type AstNode = {
  type: string;
  name?: string;
  value?:
    | string
    | number
    | boolean
    | null
    | AstNode
    | { cooked?: string | null; raw?: string };
  argument?: AstNode;
  arguments?: AstNode[];
  body?: AstNode | AstNode[];
  callee?: AstNode;
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
      | 'delegateOnly'
      | 'missingAlarm'
      | 'physicalAlarm'
      | 'tableCreation'
      | 'tableName';
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

const nodeValue = (value: AstNode['value']): AstNode | undefined =>
  typeof value === 'object' && value !== null && 'type' in value
    ? (value as AstNode)
    : undefined;

const propertyName = (node: AstNode | undefined) => {
  if (!node) {
    return undefined;
  }
  if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') {
    return node.name;
  }
  if (
    (node.type === 'Literal' || node.type === 'StringLiteral') &&
    typeof node.value === 'string'
  ) {
    return node.value;
  }
  return undefined;
};

const durabilityConstructors = new Set([
  'Durability',
  'DurabilityAlarms',
  'DurabilityFanout',
  'DurabilityScheduler',
]);

/** Class fields holding a durability helper, by declared name. */
const durabilityFields = (members: AstNode[]): Set<string> => {
  const fields = new Set<string>();
  for (const member of members) {
    if (member.type !== 'PropertyDefinition') {
      continue;
    }
    const name = propertyName(member.key);
    const value = nodeValue(member.value);
    const constructed =
      value?.type === 'NewExpression' &&
      value.callee?.type === 'Identifier' &&
      durabilityConstructors.has(value.callee.name ?? '');
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
    },
  },
  create(context: RuleContext) {
    const durabilityClasses = new WeakSet<AstNode>();
    const checkClass = (node: AstNode) => {
      const members = bodyMembers(node);
      const alarm = members.find(
        (member) =>
          member.type === 'MethodDefinition' &&
          propertyName(member.key) === 'alarm'
      );
      const fields = durabilityFields(members);
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

    return {
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
      CallExpression(node: AstNode) {
        if (node.callee?.type !== 'MemberExpression') {
          return;
        }
        const method = propertyName(node.callee.property);
        if (method !== 'setAlarm' && method !== 'deleteAlarm') {
          return;
        }

        let parent = node.parent;
        while (
          parent &&
          parent.type !== 'ClassDeclaration' &&
          parent.type !== 'ClassExpression'
        ) {
          parent = parent.parent;
        }
        if (parent && durabilityClasses.has(parent)) {
          context.report({ node, messageId: 'physicalAlarm' });
        }
      },
    };
  },
};

const staticStringValue = (node: AstNode | undefined): string | undefined => {
  if (!node) {
    return undefined;
  }
  if (
    (node.type === 'Literal' || node.type === 'StringLiteral') &&
    typeof node.value === 'string'
  ) {
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
    if (
      typeof quasiValue !== 'object' ||
      quasiValue === null ||
      'type' in quasiValue
    ) {
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

    const resolveVariable = (node: AstNode | undefined) => {
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
        const constructor = resolveVariable(node.callee);
        if (constructor && queryBuilderConstructors.has(constructor)) {
          return true;
        }
      }
      if (node.type === 'Identifier') {
        const variable = resolveVariable(node);
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
            source === '@durability/storage' &&
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
            ? resolveVariable(node.init.typeAnnotation?.typeName)
            : undefined;
        const declaredType = resolveVariable(
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

export default {
  meta: { name: 'durability' },
  rules: {
    'alarm-runner-only': alarmRunnerRule,
    'durability-migrations-only': durabilityMigrationsRule,
  },
};
