import { defineConfig } from 'vite';
import { doTransforms } from '@durability/transforms/vite';

// Maps DurabilitySemaphore.client({ target: AccountLimit }) to the Worker
// export declared in Wrangler. Without the plugin, set exportName explicitly.
export default defineConfig({
  plugins: [doTransforms({ wrangler: './wrangler.jsonc' })],
});
