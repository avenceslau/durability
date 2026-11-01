import { defineCollection } from 'astro:content';
// `z` re-exported from `astro:content` is deprecated; import it from
// `astro/zod` (the pattern nimbus-docs' own schema helpers document).
import { z } from 'astro/zod';
import {
  docsCollection,
  partialsCollection,
} from '@cloudflare/nimbus-docs/content';

export const collections = {
  docs: defineCollection(
    docsCollection({
      schemaFields: {
        // Nimbus docs are agent-friendly by default. Set `audience: human`
        // to flag a page that's written primarily for human readers.
        audience: z.literal('human').optional(),
        // Generated companion references live in package READMEs rather than
        // this collection. Nimbus's editPattern covers normal docs; this
        // explicit source link keeps those pages accurate.
        sourceEditUrl: z.url().optional(),
      },
    })
  ),
  partials: defineCollection(partialsCollection()),
};
