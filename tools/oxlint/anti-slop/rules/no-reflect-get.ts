import { defineRule } from "@oxlint/plugins";

import { isGlobalReflectMethodCall } from "../shared/reflect-method.ts";

import type { ESTree } from "@oxlint/plugins";

/** Reports whether a call sits directly in the `get` trap of a `new Proxy(target, handler)` handler literal. */
function isInProxyGetTrap(node: ESTree.CallExpression): boolean {
  let trap: ESTree.Node | null = node.parent;
  while (
    trap !== null &&
    trap.type !== "FunctionExpression" &&
    trap.type !== "ArrowFunctionExpression" &&
    trap.type !== "FunctionDeclaration"
  ) {
    trap = trap.parent;
  }

  const property = trap?.parent;
  if (property?.type !== "Property") return false;
  if (property.key.type !== "Identifier" || property.key.name !== "get") return false;

  const handler = property.parent;
  const proxy = handler?.parent;
  return (
    proxy?.type === "NewExpression" &&
    proxy.callee.type === "Identifier" &&
    proxy.callee.name === "Proxy" &&
    proxy.arguments[1] === handler
  );
}

/** Ban Reflect.get, which bypasses ordinary property access and useful type evidence. */
export const noReflectGetRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Reflect.get; use typed property access or parse dynamic input into a domain type.",
    },
    messages: {
      reflectGet:
        "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        // Forwarding from a Proxy `get` trap is the purpose Reflect.get exists for.
        if (isInProxyGetTrap(node)) return;
        if (isGlobalReflectMethodCall(context.sourceCode, node.callee, "get")) {
          context.report({ node, messageId: "reflectGet" });
        }
      },
    };
  },
});
