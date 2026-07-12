const propertyName = (node) => {
  if (!node) {
    return undefined;
  }
  if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') {
    return node.name;
  }
  if (node.type === 'Literal' || node.type === 'StringLiteral') {
    return node.value;
  }
  return undefined;
};

const isDurabilityAlarmCall = (node) => {
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
  create(context) {
    const checkClass = (node) => {
      const members = node.body?.body ?? [];
      const alarm = members.find(
        (member) =>
          member.type === 'MethodDefinition' &&
          propertyName(member.key) === 'alarm'
      );
      if (!alarm) {
        return;
      }

      const statements = alarm.value?.body?.body ?? [];
      const usesDurability =
        members.some(
          (member) =>
            member.type === 'PropertyDefinition' &&
            (propertyName(member.key) === 'durability' ||
              (member.value?.type === 'CallExpression' &&
                propertyName(member.value.callee) === 'createDurability'))
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
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee?.type !== 'MemberExpression') {
          return;
        }
        if (propertyName(node.callee.property) !== 'migrations') {
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
          propertyName(tableName.value) !== 'durability_migrations'
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
