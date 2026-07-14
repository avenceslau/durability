type AstNode = {
  type: string;
  name?: string;
  value?: string | number | boolean | null | AstNode;
  argument?: AstNode;
  arguments?: AstNode[];
  body?: AstNode | AstNode[];
  callee?: AstNode;
  id?: AstNode;
  imported?: AstNode;
  init?: AstNode;
  key?: AstNode;
  local?: AstNode;
  object?: AstNode;
  properties?: AstNode[];
  property?: AstNode;
  source?: AstNode;
  specifiers?: AstNode[];
};

type RuleContext = {
  report: (input: {
    node: AstNode;
    messageId: 'delegateOnly' | 'tableName';
  }) => void;
};

const bodyMembers = (node: AstNode | undefined): AstNode[] => {
  if (!node?.body || Array.isArray(node.body)) {
    return [];
  }
  return Array.isArray(node.body.body) ? node.body.body : [];
};

const nodeValue = (value: AstNode['value']): AstNode | undefined =>
  typeof value === 'object' && value !== null ? value : undefined;

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

const isDurabilityAlarmCall = (node: AstNode | undefined) => {
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
    propertyName(receiver.property) === 'durability'
  );
};

const alarmRunnerRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      delegateOnly:
        'A durability alarm runner must only return durability.alarm(alarmInfo).',
    },
  },
  create(context: RuleContext) {
    const checkClass = (node: AstNode) => {
      const members = bodyMembers(node);
      const alarm = members.find(
        (member) =>
          member.type === 'MethodDefinition' &&
          propertyName(member.key) === 'alarm'
      );
      if (!alarm) {
        return;
      }

      const statements = bodyMembers(nodeValue(alarm.value));
      const usesDurability =
        members.some(
          (member) =>
            member.type === 'PropertyDefinition' &&
            (propertyName(member.key) === 'durability' ||
              (nodeValue(member.value)?.type === 'CallExpression' &&
                propertyName(nodeValue(member.value)?.callee) ===
                  'createDurability'))
        ) ||
        statements.some(
          (statement) =>
            statement.type === 'ReturnStatement' &&
            isDurabilityAlarmCall(statement.argument)
        );
      if (!usesDurability) {
        return;
      }

      const statement = statements[0];
      const valid =
        statements.length === 1 &&
        statement?.type === 'ReturnStatement' &&
        isDurabilityAlarmCall(statement.argument);
      if (!valid) {
        context.report({ node: alarm, messageId: 'delegateOnly' });
      }
    };

    return {
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    };
  },
};

const durabilityMigrationsRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      tableName:
        'workers-qb migrations must use the durability_migrations table.',
    },
  },
  create(context: RuleContext) {
    const queryBuilderConstructors = new Set<string>();
    const queryBuilders = new Set<string>();

    return {
      ImportDeclaration(node: AstNode) {
        if (propertyName(node.source) !== 'workers-qb') {
          return;
        }

        for (const specifier of node.specifiers ?? []) {
          if (
            specifier.type === 'ImportSpecifier' &&
            propertyName(specifier.imported) === 'DOQB'
          ) {
            const localName = propertyName(specifier.local);
            if (localName) {
              queryBuilderConstructors.add(localName);
            }
          }
        }
      },
      VariableDeclarator(node: AstNode) {
        if (
          node.id?.type === 'Identifier' &&
          node.init?.type === 'NewExpression' &&
          node.init.callee?.type === 'Identifier' &&
          queryBuilderConstructors.has(node.init.callee.name ?? '')
        ) {
          queryBuilders.add(node.id.name ?? '');
        }
      },
      CallExpression(node: AstNode) {
        if (
          node.callee?.type !== 'MemberExpression' ||
          propertyName(node.callee.property) !== 'migrations'
        ) {
          return;
        }

        const receiver = node.callee.object;
        const isWorkersQueryBuilder =
          (receiver?.type === 'Identifier' &&
            queryBuilders.has(receiver.name ?? '')) ||
          (receiver?.type === 'NewExpression' &&
            receiver.callee?.type === 'Identifier' &&
            queryBuilderConstructors.has(receiver.callee.name ?? ''));
        if (!isWorkersQueryBuilder) {
          return;
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
