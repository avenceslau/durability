import type { Unstable_Config } from 'wrangler';

// Bindings whose runtime values are not RPC-capable objects. Proxying module
// blobs would also break identity checks such as `WebAssembly.instantiate`.
const unwrappedBindingTypes = new Set([
  'data_blob',
  'durable_object_namespace',
  'json',
  'plain_text',
  'secret_text',
  'text_blob',
  'wasm_module',
]);

/** Names from a Wrangler config that decide what the plugin rewrites. */
export type WranglerBindings = {
  /** Durable Object namespace bindings, whose `get` calls return stubs. */
  durableObjectBindingNames: ReadonlySet<string>;
  /** Every other binding whose value is an RPC-capable object. */
  stubBindingNames: ReadonlySet<string>;
  /** Durable Object classes defined by this Worker. */
  durableObjectClassNames: ReadonlySet<string>;
};

export type WranglerProject = {
  configPath: string;
  config: Unstable_Config;
  bindings: WranglerBindings;
};

export async function loadWranglerProject(
  configPath: string
): Promise<WranglerProject> {
  const wrangler = await import('wrangler');
  let config: Unstable_Config;
  try {
    config = wrangler.unstable_readConfig(
      { config: configPath },
      { hideWarnings: true, preserveOriginalMain: true }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new Error(
        `do-transforms could not load a valid Wrangler configuration at ${configPath}: ${detail}`
      ),
      { cause: error }
    );
  }

  const durableObjectBindings = config.durable_objects.bindings;
  const startWorkerBindings =
    wrangler.unstable_convertConfigBindingsToStartWorkerBindings(config) ?? {};

  return {
    configPath,
    config,
    bindings: {
      durableObjectBindingNames: new Set(
        durableObjectBindings.map((binding) => binding.name)
      ),
      stubBindingNames: new Set(
        Object.entries(startWorkerBindings).flatMap(([name, binding]) => {
          const type: unknown = Reflect.get(Object(binding), 'type');
          return typeof type !== 'string' ||
            unwrappedBindingTypes.has(type) ||
            type.startsWith('unsafe_')
            ? []
            : [name];
        })
      ),
      durableObjectClassNames: new Set([
        ...durableObjectBindings.flatMap((binding) =>
          binding.script_name === undefined ? [binding.class_name] : []
        ),
        ...(config.migrations ?? []).flatMap((migration) => [
          ...(migration.new_sqlite_classes ?? []),
          ...(migration.new_classes ?? []),
        ]),
      ]),
    },
  };
}

/** Returns the `Env` declarations `wrangler types` generates for a config. */
export async function generateEnvTypes(
  configPath: string,
  typesPath: string
): Promise<string> {
  const wrangler = await import('wrangler');
  try {
    const { env } = await wrangler.experimental_generateTypes({
      config: configPath,
      includeRuntime: false,
      path: typesPath,
    });
    return env ?? '';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new Error(
        `do-transforms could not generate Wrangler binding types for ${configPath}: ${detail}`
      ),
      { cause: error }
    );
  }
}
