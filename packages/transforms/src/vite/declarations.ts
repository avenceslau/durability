import { parse as parseJavaScript } from '@babel/parser';
import { forEachChild, identifierName, syntaxNode } from './syntax.js';

/**
 * Reads binding types from `wrangler types` output. Types that Wrangler could
 * not resolve carry a placeholder comment and are skipped so they do not
 * conflict with hand-written declarations.
 */
export function wranglerBindingTypes(source: string): Map<string, string> {
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
