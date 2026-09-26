# Examples

Source recipes for the durability primitives, typechecked and linted by `pnpm check` against current workspace source.

| Example                                            | Capabilities                                       | Shows                                                                                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`image-jobs`](./image-jobs)                       | `Durability`                                       | Idempotency keys forwarded upstream, permanent failures, persisted outcomes.                                                                                                               |
| [`subscription-renewals`](./subscription-renewals) | `DurabilityAlarms` + `DurabilityScheduler`         | Recurring alarms registering operations and sharing one physical alarm.                                                                                                                    |
| [`email-queue`](./email-queue)                     | `DurabilityRouting` + `DurabilityFanout` + storage | Application-owned DO, static consumer and archive targets, per-target DLQ redrive, acceptance/load envelopes, location hints and caller transforms. No queue wrapper or generated classes. |
| [`rpc-transforms`](./rpc-transforms)               | `@durability/transforms`                           | Standalone caller/callee middleware, context transport, timeout and retry on a plain DO.                                                                                                   |

Each example includes Wrangler configuration; upstream service bindings must point to real services or local stubs. Authenticate and validate HTTP inputs before using these sketches in an application. Administrative redrive should be protected, not exposed publicly.

The email composition uses Vite's `doTransforms` plugin to resolve `target: EmailDelivery` to the application's exported class name. Integrate it with your Worker Vite build, or set `exportName: 'EmailDelivery'` explicitly when running with Wrangler alone. No redundant DO binding is required for loopback namespaces, but the class must be declared in migrations. Configure a 30-day R2 lifecycle deletion rule on `email-dlq/`; archive retention is independent.

A fanout target is not a global subscriber registry. Keep target IDs stable: changing/removing one leaves its previously accepted work pending until restored. Retries and redrive are at-least-once, so upstream effects must be idempotent.
