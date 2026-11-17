import type { ESTree } from "@oxlint/plugins";

/** Reports whether a call sits directly in the named trap of a `new Proxy(target, handler)` handler literal. */
export function isInProxyTrap(node: ESTree.CallExpression, trapName: string): boolean {
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
  if (property.key.type !== "Identifier" || property.key.name !== trapName) return false;

  const handler = property.parent;
  const proxy = handler?.parent;
  return (
    proxy?.type === "NewExpression" &&
    proxy.callee.type === "Identifier" &&
    proxy.callee.name === "Proxy" &&
    proxy.arguments[1] === handler
  );
}
