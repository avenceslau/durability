import { syntaxNode, type SyntaxNode } from './syntax.js';

export type Wrapper = {
  start: number;
  end: number;
  namespaceCall?:
    | {
        calleeStart: number;
        objectEnd: number;
        calleeEnd: number;
        method: string;
        insertOptional: boolean;
      }
    | undefined;
};

export function unusedName(code: string, name: string): string {
  let candidate = name;
  while (new RegExp(`\\b${candidate}\\b`).test(code)) {
    candidate += '_';
  }
  return candidate;
}

/**
 * Locates the edits that turn `namespace.get(args)` into
 * `factory(namespace, "get")(args)`, leaving the arguments untouched so they are
 * evaluated once and reused whenever the stub is restored.
 */
export function namespaceCall(
  code: string,
  call: SyntaxNode,
  callee: SyntaxNode,
  method: string
): Wrapper['namespaceCall'] {
  const object = syntaxNode(callee.object);
  if (
    typeof callee.start !== 'number' ||
    typeof callee.end !== 'number' ||
    typeof object?.end !== 'number'
  ) {
    return undefined;
  }

  // Babel excludes wrapping parentheses from node ranges; keep them, and any
  // comments among them, with the object.
  let objectEnd = object.end;
  for (;;) {
    if (/[\s)]/.test(code[objectEnd] ?? '')) {
      objectEnd += 1;
    } else if (code.startsWith('/*', objectEnd)) {
      objectEnd = code.indexOf('*/', objectEnd) + 2;
    } else if (code.startsWith('//', objectEnd)) {
      objectEnd = code.indexOf('\n', objectEnd);
    } else {
      break;
    }
  }

  return {
    calleeStart: callee.start,
    objectEnd,
    calleeEnd: callee.end,
    method,
    // `env?.NS.get(id)` must still short-circuit once the chain is split.
    insertOptional:
      callee.type === 'OptionalMemberExpression' && call.optional !== true,
  };
}
