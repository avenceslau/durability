import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveConfig, type ResolvedConfig, type Rolldown } from 'vite';
import {
  unstable_convertConfigBindingsToStartWorkerBindings,
  unstable_readConfig,
} from 'wrangler';
import { isFunction, isString } from '../src/predicates';
import { doTransforms, type DoTransformsPluginOptions } from '../src/vite';
import { loadWranglerProject } from '../src/vite/wrangler';

type TestPlugin = {
  configResolved(config: ResolvedConfig): Promise<void> | void;
  /** Resolves to the transformed code, or null when the module is unchanged. */
  transform(code: string, id: string): Promise<string | null>;
};

/** The plugin's hooks, called the way Vite calls plain function hooks. */
function pluginHooks(options: DoTransformsPluginOptions): TestPlugin {
  const { configResolved, transform: transformHook } = doTransforms(options);

  if (!isFunction(configResolved) || !isFunction(transformHook)) {
    throw new Error('do-transforms hooks must be functions');
  }

  const runTransform: (
    code: string,
    id: string
  ) => Promise<Rolldown.TransformResult> | Rolldown.TransformResult =
    transformHook;

  return {
    configResolved,
    async transform(code, id) {
      const result = await runTransform(code, id);

      if (result === null || result === undefined) {
        return null;
      }

      if (isString(result) || !isString(result.code)) {
        throw new Error(
          'do-transforms must return code in a source description'
        );
      }

      return result.code;
    },
  };
}

const fixtureRoot = resolve(import.meta.dirname, 'fixtures/vite');
let plugin: TestPlugin;
let fixtureConfig: ResolvedConfig;

beforeAll(async () => {
  fixtureConfig = await resolveConfig(
    { root: fixtureRoot, configFile: false },
    'build'
  );
  plugin = pluginHooks({
    wrangler: './wrangler.jsonc',
    types: false,
  });
  await plugin.configResolved(fixtureConfig);
});

function transform(code: string): Promise<string | null> {
  return plugin.transform(code, join(fixtureRoot, 'worker.ts'));
}

function transformWith(
  testPlugin: TestPlugin,
  code: string
): Promise<string | null> {
  return testPlugin.transform(code, join(fixtureRoot, 'worker.ts'));
}

describe('Vite binding transforms', () => {
  it('reads the Wrangler config with warnings hidden and the original main preserved', () => {
    const configPath = join(fixtureRoot, 'wrangler.jsonc');
    const readConfig = vi.fn(unstable_readConfig);

    const project = loadWranglerProject(configPath, {
      unstable_readConfig: readConfig,
      unstable_convertConfigBindingsToStartWorkerBindings,
    });

    expect(readConfig).toHaveBeenCalledWith(
      { config: configPath },
      { hideWarnings: true, preserveOriginalMain: true }
    );
    expect(project.config.main).toBe('../../worker.ts');
  });

  it('resolves the Wrangler config path against the Vite root', async () => {
    expect(process.cwd()).not.toBe(fixtureRoot);

    await expect(
      transform(
        'export default { fetch(request, env) { env.CONTEXT_SERVICE.greet(); } };'
      )
    ).resolves.toContain(
      '__doTransformsCreateStub(env.CONTEXT_SERVICE).greet()'
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

  it('wraps every object binding and leaves plain values alone', async () => {
    const result = await transform(`
export default {
  fetch(request, env) {
    const { CACHE } = env;
    env.CACHE.get("key");
    CACHE.put("key", "value");
    env.GREETING.toUpperCase();
    WebAssembly.instantiate(env.MODULE);
  }
};
`);

    expect(result).toContain('__doTransformsCreateStub(env.CACHE).get("key")');
    expect(result).toContain(
      '__doTransformsCreateStub(CACHE).put("key", "value")'
    );
    expect(result).toContain('env.GREETING.toUpperCase()');
    expect(result).toContain('WebAssembly.instantiate(env.MODULE)');
    expect(result?.match(/__doTransformsCreateStub\(/g)).toHaveLength(2);
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

  it('rewrites namespace stubs to restorable factories when enabled', async () => {
    const restorePlugin = pluginHooks({
      wrangler: './wrangler.jsonc',
      types: false,
      restoreBrokenStubs: true,
    });

    await restorePlugin.configResolved(fixtureConfig);

    const result = await transformWith(
      restorePlugin,
      `
export default {
  fetch(request, env) {
    env.CONTEXT_SERVICE.greet();
    env.CONTEXT_DO.get(env.CONTEXT_DO.newUniqueId());
    env["CONTEXT_DO"].getByName("direct");
    env?.CONTEXT_DO?.get?.(env.dynamicName);
    env?.CONTEXT_DO.getByName("chain").greet();
    (env.CONTEXT_DO).getByName("parens");
    (env.CONTEXT_DO as any).get(id);
    (env.CONTEXT_DO.getByName)("callee");
    (env.CONTEXT_DO /* keep ) */).getByName("comment");
  }
};
`
    );

    expect(result).toContain(
      "import { createTransformStub as __doTransformsCreateStub, createRestorableStubFactory as __doTransformsRestorableStub } from '@durability/transforms';"
    );
    expect(result).toContain(
      '__doTransformsCreateStub(env.CONTEXT_SERVICE).greet()'
    );
    expect(result).toContain(
      '__doTransformsRestorableStub(env.CONTEXT_DO, "get")(env.CONTEXT_DO.newUniqueId())'
    );
    expect(result).toContain(
      '__doTransformsRestorableStub(env["CONTEXT_DO"], "getByName")("direct")'
    );
    expect(result).toContain(
      '__doTransformsRestorableStub(env?.CONTEXT_DO, "get")?.(env.dynamicName)'
    );
    expect(result).toContain(
      '__doTransformsRestorableStub(env?.CONTEXT_DO, "getByName")?.("chain").greet()'
    );
    expect(result).toContain(
      '__doTransformsRestorableStub((env.CONTEXT_DO), "getByName")("parens")'
    );
    expect(result).toContain(
      '__doTransformsRestorableStub((env.CONTEXT_DO as any), "get")(id)'
    );
    expect(result).toContain(
      '(__doTransformsRestorableStub(env.CONTEXT_DO, "getByName"))("callee")'
    );
    expect(result).toContain(
      '__doTransformsRestorableStub((env.CONTEXT_DO /* keep ) */), "getByName")("comment")'
    );
  });

  it('only imports the restorable factory when no service is wrapped', async () => {
    const restorePlugin = pluginHooks({
      wrangler: './wrangler.jsonc',
      types: false,
      restoreBrokenStubs: true,
    });

    await restorePlugin.configResolved(fixtureConfig);

    const result = await transformWith(
      restorePlugin,
      'export default { fetch(request, env) { return env.CONTEXT_DO.getByName("a"); } };'
    );

    expect(result).toContain(
      "import { createRestorableStubFactory as __doTransformsRestorableStub } from '@durability/transforms';"
    );
    expect(result).not.toContain('createTransformStub');
  });

  it('parses angle-bracket type assertions in TypeScript modules', async () => {
    const result = await plugin.transform(
      `
type Env = { CONTEXT_SERVICE: { greet(): string } };
export default {
  fetch(request: Request, env: Env) {
    const raw = <unknown>JSON.parse('{}');
    return (<Env>env).CONTEXT_SERVICE.greet();
  }
};
`,
      join(fixtureRoot, 'worker.ts?import')
    );

    expect(result).toContain(
      '__doTransformsCreateStub((<Env>env).CONTEXT_SERVICE).greet()'
    );
  });

  it('parses JSX in TSX modules', async () => {
    const result = await plugin.transform(
      `
export default {
  fetch(request, env) {
    env.CONTEXT_SERVICE.greet();
    return <p title="greeting">{env.GREETING}</p>;
  }
};
`,
      join(fixtureRoot, 'worker.tsx')
    );

    expect(result).toContain(
      '__doTransformsCreateStub(env.CONTEXT_SERVICE).greet()'
    );
  });

  it('reports invalid Wrangler configuration', async () => {
    const wranglerPath = join(fixtureRoot, 'invalid.jsonc');

    const invalidPlugin = pluginHooks({
      wrangler: wranglerPath,
      types: false,
    });

    const loading = invalidPlugin.configResolved(fixtureConfig);

    await expect(loading).rejects.toThrow(
      `do-transforms could not load a valid Wrangler configuration at ${wranglerPath}: Processing `
    );
    await expect(loading).rejects.toThrow(
      'The field "services" should be an array but got {"binding":"CONTEXT_SERVICE"}.'
    );
  });

  it('rejects a types path that is not a declaration file', async () => {
    const typesPlugin = pluginHooks({
      wrangler: './wrangler.jsonc',
      types: './env.ts',
    });

    await expect(typesPlugin.configResolved(fixtureConfig)).rejects.toThrow(
      'do-transforms types path must end in .d.ts'
    );
  });
});

describe('DurabilityRouting exportName injection', () => {
  it('injects the exported target name last in an inline client config', async () => {
    const result = await transform(`
import { DurabilityRouting } from 'durability/routing';
export class Mailbox extends DurableObject {}
const router = DurabilityRouting.client({
  target: Mailbox,
  invoke: (stub, input) => stub.enqueue(input),
  ...defaults,
});
`);

    expect(result).toContain('...defaults,\n exportName: "Mailbox"');
  });

  it('injects for DurabilitySemaphore.client from durability/experimental/semaphore', async () => {
    const result = await transform(`
import { DurabilitySemaphore } from 'durability/experimental/semaphore';
export class Mailbox extends DurableObject {}
const limits = DurabilitySemaphore.client({
  target: Mailbox,
  invoke: (stub, message) => stub.permits(message),
});
`);

    expect(result).toContain('exportName: "Mailbox"');
  });

  it('ignores a client factory imported from an unrelated module', async () => {
    const result = await transform(`
import { DurabilitySemaphore } from 'somewhere-else';
export class Mailbox extends DurableObject {}
DurabilitySemaphore.client({ target: Mailbox });
`);

    expect(result).toBeNull();
  });

  it('supports aliased routing imports and exported class aliases', async () => {
    const result = await transform(`
import { DurabilityRouting as Routing } from 'durability/routing';
class Internal extends DurableObject {}
export { Internal as AliasedMailbox };
Routing.client({ target: Internal, invoke: (stub) => stub.enqueue() });
`);

    expect(result).toContain(
      'target: Internal, invoke: (stub) => stub.enqueue() , exportName: "AliasedMailbox"'
    );
  });

  it('leaves an explicit exportName untouched', async () => {
    const result = await transform(`
import { DurabilityRouting } from 'durability/routing';
DurabilityRouting.client({
  target: MissingMailbox,
  exportName: 'ExternalMailbox',
});
`);

    expect(result).toBeNull();
  });

  it('rejects targets that are not declared local Durable Object exports', async () => {
    await expect(
      transform(`
import { DurabilityRouting } from 'durability/routing';
DurabilityRouting.client({ target: UnknownMailbox, invoke: () => {} });
`)
    ).rejects.toThrow('is not a declared local class export');
  });

  it('rejects ambiguous aliases and non-static targets', async () => {
    await expect(
      transform(`
import { DurabilityRouting } from 'durability/routing';
class Internal extends DurableObject {}
export { Internal as Mailbox, Internal as OtherMailbox };
DurabilityRouting.client({ target: Internal, invoke: () => {} });
`)
    ).rejects.toThrow('ambiguous class aliases');

    await expect(
      transform(`
import { DurabilityRouting } from 'durability/routing';
export class Mailbox extends DurableObject {}
DurabilityRouting.client({ target: getMailbox(), invoke: () => {} });
`)
    ).rejects.toThrow('target must be an Identifier');
  });

  it('ignores shadowed names, unrelated clients, and type-only imports', async () => {
    const result = await transform(`
import { DurabilityRouting as Routing } from 'durability/routing';
import type { DurabilityRouting as TypeRouting } from 'durability/routing';
export class Mailbox extends DurableObject {}
const unrelated = { client() {} };
function local(Routing: typeof TypeRouting) {
  Routing.client({ target: Mailbox, invoke: () => {} });
}
unrelated.client({ target: Mailbox });
Routing.client({ target: Mailbox, invoke: () => {} });
`);

    expect(result?.match(/exportName: "Mailbox"/g)).toHaveLength(1);
  });

  it('rejects a target class name shadowed by a function parameter', async () => {
    await expect(
      transform(`
import { DurabilityRouting } from 'durability/routing';
export class Mailbox extends DurableObject {}
function create(Mailbox) {
  return DurabilityRouting.client({ target: Mailbox });
}
`)
    ).rejects.toThrow('target "Mailbox" is shadowed');
  });

  it('leaves non-inline configs for the explicit escape hatch', async () => {
    const result = await transform(`
import { DurabilityRouting } from 'durability/routing';
export class Mailbox extends DurableObject {}
const config = { target: Mailbox, invoke: () => {} };
DurabilityRouting.client(config);
`);

    expect(result).toBeNull();
  });

  it('works with migrations only and existing RPC wrapper edits', async () => {
    const migrationOnlyPlugin = pluginHooks({
      wrangler: './migrations-only.jsonc',
      types: false,
    });

    await migrationOnlyPlugin.configResolved(fixtureConfig);

    const result = await transformWith(
      migrationOnlyPlugin,
      `
import { DurabilityRouting } from 'durability/routing';
export class Mailbox extends DurableObject {}
DurabilityRouting.client({ target: Mailbox, invoke: () => {} });
`
    );

    expect(result).toContain('exportName: "Mailbox"');
    expect(result).not.toContain('createTransformStub');
  });

  it('mixes routing injection with existing RPC wrapper edits', async () => {
    const result = await transform(`
import { DurabilityRouting } from 'durability/routing';
export class Mailbox extends DurableObject {}
export default {
  fetch(request, env) {
    env.CONTEXT_SERVICE.greet();
  },
};
DurabilityRouting.client({ target: Mailbox, invoke: () => {} });
`);

    expect(result).toContain('exportName: "Mailbox"');
    expect(result).toContain(
      '__doTransformsCreateStub(env.CONTEXT_SERVICE).greet()'
    );
    expect(result?.match(/createTransformStub as/g)).toHaveLength(1);
  });
});

describe('Workers cache entrypoint generation', () => {
  const cacheMain = join(fixtureRoot, 'cache-worker.ts');
  let cachePlugin: TestPlugin;

  beforeAll(async () => {
    cachePlugin = pluginHooks({
      wrangler: './cache.jsonc',
      types: false,
      cacheEntrypoints: true,
    });
    await cachePlugin.configResolved(fixtureConfig);
  });

  const generate = (code: string) => cachePlugin.transform(code, cacheMain);

  const accountModule = (plan: string) => `
import { DurableObject } from 'cloudflare:workers';
import { cachePlan } from '@durability/transforms/cache';
export class Account extends DurableObject {
  async getMetadata(id: number) { return { id }; }
}
${plan}
`;

  it('appends an entrypoint that serves the plan from the target namespace', async () => {
    const generated = await generate(
      accountModule(
        'export const accountCache = cachePlan<Account>()({ getMetadata: policy });'
      )
    );

    expect(generated).toContain(
      "import { WorkerEntrypoint as __durabilityWorkerEntrypoint, exports as __durabilityWorkerExports } from 'cloudflare:workers';"
    );
    expect(generated).toContain(
      "import { serveCached as __durabilityServeCached } from '@durability/transforms/cache';"
    );
    expect(generated).toContain(`
export class AccountReads extends __durabilityWorkerEntrypoint {
  fetch(request) {
    return __durabilityServeCached(request, accountCache, {
      namespace: __durabilityWorkerExports["Account"],
    });
  }
}`);
  });

  it('uses the entrypoint name from the plan options and skips entrypoint: false', async () => {
    const generated = await generate(
      accountModule(`
const accountCache = cachePlan<Account>({ version: 2, entrypoint: 'CustomReads' })({});
const handWritten = cachePlan<Account>({ entrypoint: false })({});
`)
    );

    expect(generated).toContain('export class CustomReads extends');
    expect(generated).toContain(
      '__durabilityServeCached(request, accountCache,'
    );
    expect(generated).not.toContain('handWritten,');
    expect(generated).not.toContain('AccountReads');
  });

  it('skips every check for a plan with entrypoint: false', async () => {
    await expect(
      generate(`
import { cachePlan } from '@durability/transforms/cache';
import type { Service } from './service';
const serviceCache = cachePlan<Service>({ entrypoint: false })({});
`)
    ).resolves.toBeNull();
  });

  it('supports an aliased cachePlan import', async () => {
    const generated = await generate(`
import { DurableObject } from 'cloudflare:workers';
import { cachePlan as plan } from '@durability/transforms/cache';
export class Account extends DurableObject {}
const accountCache = plan<Account>()({});
`);

    expect(generated).toContain('export class AccountReads extends');
  });

  it('leaves modules other than the main module and other cachePlan imports alone', async () => {
    const plan = accountModule(
      'const accountCache = cachePlan<Account>()({});'
    );

    await expect(
      cachePlugin.transform(plan, join(fixtureRoot, 'other.ts'))
    ).resolves.toBeNull();
    await expect(
      generate(`
import type { cachePlan } from '@durability/transforms/cache';
export class Account extends DurableObject {}
const accountCache = cachePlan<Account>()({});
`)
    ).resolves.toBeNull();
    await expect(
      generate(`
import { cachePlan } from 'somewhere-else';
export class Account extends DurableObject {}
const accountCache = cachePlan<Account>()({});
`)
    ).resolves.toBeNull();
  });

  it('does nothing unless cacheEntrypoints is enabled', async () => {
    const disabled = pluginHooks({ wrangler: './cache.jsonc', types: false });
    await disabled.configResolved(fixtureConfig);

    await expect(
      disabled.transform(
        accountModule('const accountCache = cachePlan<Account>()({});'),
        cacheMain
      )
    ).resolves.toBeNull();
  });

  it('requires the Workers cache enabled for the entrypoint in Wrangler', async () => {
    await expect(
      generate(
        accountModule(
          "const accountCache = cachePlan<Account>({ entrypoint: 'UncachedReads' })({});"
        )
      )
    ).rejects.toThrow(
      'Add {"exports":{"UncachedReads":{"type":"worker","cache":{"enabled":true}}}}'
    );
    await expect(
      generate(
        accountModule(
          "const accountCache = cachePlan<Account>({ entrypoint: 'MissingReads' })({});"
        )
      )
    ).rejects.toThrow('generates the entrypoint MissingReads');
  });

  it('rejects plans it cannot generate an entrypoint for', async () => {
    await expect(
      generate(accountModule('const accountCache = cachePlan()({});'))
    ).rejects.toThrow('must name its Durable Object class');
    await expect(
      generate(accountModule('const accountCache = cachePlan<Other>()({});'))
    ).rejects.toThrow(
      'cachePlan "accountCache" target "Other" is not a declared local class export'
    );
    await expect(
      generate(
        accountModule('const accountCache = cachePlan<Account>(options)({});')
      )
    ).rejects.toThrow('options must be an object literal');
    await expect(
      generate(
        accountModule(
          'const accountCache = cachePlan<Account>({ entrypoint: name })({});'
        )
      )
    ).rejects.toThrow('entrypoint must be false or a string literal');
    await expect(
      generate(
        accountModule(`
export class AccountReads {}
const accountCache = cachePlan<Account>()({});
`)
      )
    ).rejects.toThrow('the module already declares that name');
  });
});
