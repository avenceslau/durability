import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from 'vite';
import { doTransforms } from '../src/vite';

type TestPlugin = {
  configResolved(config: ResolvedConfig): Promise<void> | void;
  transform(
    code: string,
    id: string
  ):
    | Promise<{ code: string } | null | undefined>
    | { code: string }
    | null
    | undefined;
};

const readConfig = vi.hoisted(() =>
  vi.fn(({ config }: { config: string }) => {
    if (config.endsWith('invalid.jsonc')) {
      throw new Error('Expected services to be an array');
    }
    return {
      durable_objects: {
        bindings: [{ class_name: 'ContextDO', name: 'CONTEXT_DO' }],
      },
      main: 'tests/test-worker.ts',
      name: 'do-transforms-test',
      services: [
        {
          binding: 'CONTEXT_SERVICE',
          entrypoint: 'ContextService',
          service: 'do-transforms-test',
        },
      ],
    };
  })
);

vi.mock('wrangler', () => ({ unstable_readConfig: readConfig }));

const packageRoot = resolve(import.meta.dirname, '..');
let plugin: TestPlugin;

beforeAll(async () => {
  plugin = doTransforms({
    wrangler: './wrangler.test.jsonc',
    types: false,
  }) as unknown as TestPlugin;
  await plugin.configResolved({ root: packageRoot } as ResolvedConfig);
});

async function transform(code: string): Promise<string | null> {
  const result = await plugin.transform(code, join(packageRoot, 'worker.ts'));
  return result?.code ?? null;
}

describe('Vite binding transforms', () => {
  it('loads validated Wrangler config with an absolute path and preserved main', () => {
    expect(readConfig).toHaveBeenCalledWith(
      { config: join(packageRoot, 'wrangler.test.jsonc') },
      { hideWarnings: true, preserveOriginalMain: true }
    );
  });

  it('wraps direct env and this.env access, including optional and computed access', async () => {
    const result = await transform(`
export default {
  fetch(request, env) {
    env.CONTEXT_SERVICE.greet();
    env["CONTEXT_DO"].getByName("direct");
    env?.["CONTEXT_SERVICE"]?.greet();
    env?.CONTEXT_DO?.get?.(env.dynamicName);
  }
};
class Entrypoint extends WorkerEntrypoint {
  run() {
    return this.env.CONTEXT_SERVICE.greet();
  }
}
`);

    expect(result).toContain(
      '__doTransformsCreateStub(env.CONTEXT_SERVICE).greet()'
    );
    expect(result).toContain(
      '__doTransformsCreateStub(env["CONTEXT_DO"].getByName("direct"))'
    );
    expect(result).toContain(
      '__doTransformsCreateStub(env?.["CONTEXT_SERVICE"])?.greet()'
    );
    expect(result).toContain(
      '__doTransformsCreateStub(env?.CONTEXT_DO?.get?.(env.dynamicName))'
    );
    expect(result).toContain(
      '__doTransformsCreateStub(this.env.CONTEXT_SERVICE).greet()'
    );
  });

  it('supports constant aliases and destructuring', async () => {
    const result = await transform(`
export default {
  fetch(request, env) {
    const service = env.CONTEXT_SERVICE;
    const namespace = env.CONTEXT_DO;
    const {
      CONTEXT_SERVICE: destructuredService,
      ["CONTEXT_DO"]: destructuredNamespace,
    } = env;
    service.greet();
    namespace.getByName("alias");
    destructuredService.greet();
    destructuredNamespace.get(env.id);
  }
};
`);

    expect(result).toContain(
      'const service = __doTransformsCreateStub(env.CONTEXT_SERVICE)'
    );
    expect(result).toContain('service.greet()');
    expect(result).not.toContain('__doTransformsCreateStub(service)');
    expect(result).toContain(
      '__doTransformsCreateStub(namespace.getByName("alias"))'
    );
    expect(result).toContain(
      '__doTransformsCreateStub(destructuredService).greet()'
    );
    expect(result).toContain(
      '__doTransformsCreateStub(destructuredNamespace.get(env.id))'
    );
  });

  it('ignores same-name unrelated properties, dynamic names, and shadowed aliases', async () => {
    const result = await transform(`
const unrelated = {
  CONTEXT_SERVICE: { greet() {} },
  CONTEXT_DO: { get() {} },
};
unrelated.CONTEXT_SERVICE.greet();
unrelated.CONTEXT_DO.get();
export default {
  fetch(request, env) {
    const { CONTEXT_SERVICE } = env;
    CONTEXT_SERVICE.greet();
    {
      const CONTEXT_SERVICE = unrelated.CONTEXT_SERVICE;
      CONTEXT_SERVICE.greet();
      const env = unrelated;
      env.CONTEXT_SERVICE.greet();
    }
    env[request.binding].greet();
  }
};
`);

    expect(result).toContain(
      '__doTransformsCreateStub(CONTEXT_SERVICE).greet()'
    );
    expect(result).toContain('unrelated.CONTEXT_SERVICE.greet()');
    expect(result).toContain('unrelated.CONTEXT_DO.get()');
    expect(result).toContain('env[request.binding].greet()');
    expect(result?.match(/__doTransformsCreateStub\(/g)).toHaveLength(1);
  });

  it('tracks aliased test env imports and ignores unrelated env parameters', async () => {
    const result = await transform(`
import { env as testEnv } from 'cloudflare:test';
testEnv.CONTEXT_SERVICE.greet();
function helper(env) {
  env.CONTEXT_SERVICE.greet();
}
`);

    expect(result).toContain(
      '__doTransformsCreateStub(testEnv.CONTEXT_SERVICE).greet()'
    );
    expect(result).toContain('env.CONTEXT_SERVICE.greet()');
    expect(result?.match(/__doTransformsCreateStub\(/g)).toHaveLength(1);
  });

  it('does not rewrite assignment, update, delete, or declaration targets', async () => {
    const code = `
export default {
  fetch(request, env) {
    env.CONTEXT_SERVICE = request.service;
    env.CONTEXT_SERVICE++;
    delete env.CONTEXT_SERVICE;
    env.CONTEXT_SERVICE.value = 1;
    const { CONTEXT_SERVICE } = env;
    CONTEXT_SERVICE = request.service;
    CONTEXT_SERVICE++;
    delete CONTEXT_SERVICE.value;
  }
};
`;

    await expect(transform(code)).resolves.toBeNull();
  });

  it('injects one helper import and deduplicates nested wrappers', async () => {
    const result = await transform(`
export default {
  fetch(request, env) {
    return env.CONTEXT_SERVICE.get();
  }
};
`);

    expect(result?.match(/createTransformStub as/g)).toHaveLength(1);
    expect(result?.match(/__doTransformsCreateStub\(/g)).toHaveLength(1);
  });

  it('reports invalid Wrangler configuration', async () => {
    const wranglerPath = join(packageRoot, 'invalid.jsonc');
    const invalidPlugin = doTransforms({
      wrangler: wranglerPath,
      types: false,
    }) as unknown as TestPlugin;

    await expect(
      invalidPlugin.configResolved({ root: packageRoot } as ResolvedConfig)
    ).rejects.toThrow(
      `do-transforms could not load a valid Wrangler configuration at ${wranglerPath}: Expected services to be an array`
    );
  });
});
