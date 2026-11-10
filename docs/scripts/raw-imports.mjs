// Vite's `?raw` suffix imports a file's text; give Node tests the same module.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('?raw')) {
      return nextLoad(url, context);
    }
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8');
    return {
      format: 'module',
      source: `export default ${JSON.stringify(text)};`,
      shortCircuit: true,
    };
  },
});
