// Bindings whose runtime values are not RPC-capable objects. Proxying module
// blobs would also break identity checks such as `WebAssembly.instantiate`.
export const unwrappedBindingTypes = new Set([
  'data_blob',
  'durable_object_namespace',
  'json',
  'plain_text',
  'secret_text',
  'text_blob',
  'wasm_module',
]);
