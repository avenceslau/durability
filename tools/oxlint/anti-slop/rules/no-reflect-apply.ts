import { defineRule } from "@oxlint/plugins";

import { isInProxyTrap } from "../shared/proxy-trap.ts";
import { isGlobalReflectMethodCall } from "../shared/reflect-method.ts";

/** Ban Reflect.apply, which bypasses ordinary typed function calls. */
export const noReflectApplyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Reflect.apply; call typed functions directly or model dynamic dispatch behind an interface.",
    },
    messages: {
      reflectApply:
        "Replace `Reflect.apply` with a typed function call. Model dynamic dispatch behind a named interface.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        // Forwarding from a Proxy `apply` trap is the purpose Reflect.apply exists for.
        if (isInProxyTrap(node, "apply")) return;
        if (isGlobalReflectMethodCall(context.sourceCode, node.callee, "apply")) {
          context.report({ node, messageId: "reflectApply" });
        }
      },
    };
  },
});
