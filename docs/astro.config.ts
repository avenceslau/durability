import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import nimbus, {
  defineConfig as defineNimbusConfig,
} from '@cloudflare/nimbus-docs';
import { tableScroll } from '@cloudflare/nimbus-docs/markdown';
import react from '@astrojs/react';

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
    // The walkthrough renders the diagram from a plain client script, outside
    // an island, where fast refresh has no preamble to attach to.
    react({ exclude: ['**/src/kit/architecture/**'] }),
    nimbus(nimbusConfig, {
      rules: {
        'nimbus/frontmatter-shape': 'error',
        'nimbus/internal-link': 'error',
      },
      markdown: {
        hastPlugins: [tableScroll()],
        componentMap: {
          ArchitectureWalkthrough: {
            revision: 'architecture-walkthrough-v2',
            render: ({ children }) => children,
          },
        },
        features: { headingAttributes: true },
      },
    }),
  ],
});
