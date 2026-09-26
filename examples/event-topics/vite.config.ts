import { defineConfig } from 'vite';
import { doTransforms } from '@durability/transforms/vite';

// Maps DurabilityRouting.client({ target: Partition }) to the Worker export
// declared in Wrangler. Without the plugin, set exportName explicitly.
export default defineConfig({
  plugins: [doTransforms({ wrangler: './wrangler.jsonc' })],
});
