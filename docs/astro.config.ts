import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import nimbus, {
  defineConfig as defineNimbusConfig,
} from '@cloudflare/nimbus-docs';
import { tableScroll } from '@cloudflare/nimbus-docs/markdown';
import mermaid from 'astro-mermaid';
import { mermaidBlocks } from './src/lib/mermaid';

const nimbusConfig = defineNimbusConfig({
  site: 'https://durability.shirei.dev',
  title: 'Durability',
  description: 'Composable durable capabilities for Cloudflare Workers.',
  locale: 'en',
  github: 'https://github.com/avenceslau/durability',
  editPattern: 'https://github.com/avenceslau/durability/edit/main/docs/{path}',
  socialImageAlt: 'Durability documentation preview',
  sidebar: {
    items: [
      {
        label: 'Start here',
        items: ['index', 'getting-started', 'concepts', 'capabilities'],
      },
      {
        label: 'Build & operate',
        items: ['production', 'examples'],
      },
      {
        label: 'Primitives',
        items: [
          'primitives/operations',
          'primitives/alarms',
          'primitives/scheduler',
          'primitives/fanout',
          'primitives/log',
          'primitives/routing',
          'primitives/socket',
          'primitives/client',
        ],
      },
      {
        label: 'Experimental primitives',
        collapsed: true,
        items: [
          'primitives/outbox',
          'primitives/schedule',
          'primitives/tracker',
          'primitives/topology',
          'primitives/semaphore',
          'primitives/semaphore-queue',
        ],
      },
      {
        label: 'Composition guides',
        items: [
          'compositions',
          'compositions/recurring-billing',
          'compositions/email-delivery',
          'compositions/job-dashboard',
          'compositions/account-concurrency',
          'compositions/event-stream',
        ],
      },
      {
        label: 'Reference',
        collapsed: true,
        items: [
          'reference',
          'reference/guarantees',
          'reference/retries',
          'reference/identity',
          'reference/memoization',
          'reference/migrations',
          'reference/retention',
          'reference/lifecycle',
          'reference/tracing',
          'reference/load-envelope',
          'reference/experimental-options',
          'reference/migrating-v3',
          'reference/storage',
          'reference/transforms',
          'reference/lint',
          'reference/tanstack-db',
        ],
      },
    ],
  },
});

export default defineConfig({
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  integrations: [
    // Keep the Mermaid browser renderer for sequence diagrams. The fences
    // are transformed explicitly inside Nimbus's own Sätteri pipeline below.
    mermaid({
      autoTheme: true,
      enableLog: false,
      mermaidConfig: { securityLevel: 'strict' },
    }),
    nimbus(nimbusConfig, {
      rules: {
        'nimbus/frontmatter-shape': 'error',
        'nimbus/internal-link': 'error',
      },
      markdown: {
        hastPlugins: [mermaidBlocks(), tableScroll()],
        componentMap: {
          ArchitectureWalkthrough: {
            revision: 'architecture-walkthrough-v1',
            render: ({ children }) => children,
          },
        },
        features: { headingAttributes: true },
      },
    }),
  ],
});
