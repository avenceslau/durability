import type { tableScroll } from '@cloudflare/nimbus-docs/markdown';

type TextNode = { value?: string; children?: TextNode[] };
const text = (node: TextNode): string =>
  node.value ?? node.children?.map(text).join('') ?? '';

/** Nimbus owns its Sätteri processor; adapt Mermaid fences in that pipeline. */
export function mermaidBlocks(): ReturnType<typeof tableScroll> {
  return {
    name: 'durability:mermaid-blocks',
    element: {
      filter: ['pre'],
      visit(node) {
        const props = node.properties ?? {};
        const language =
          props.dataLanguage ??
          props['data-language'] ??
          props.dataNbLang ??
          props['data-nb-lang'];
        if (language !== 'mermaid') {
          return;
        }
        return {
          type: 'element',
          tagName: 'pre',
          properties: { className: ['mermaid'] },
          children: [{ type: 'text', value: text(node) }],
        };
      },
    },
  };
}
