/**
 * APIs that may change or be removed in a minor release. Pin an exact
 * version of `durability` when depending on them.
 *
 * @packageDocumentation
 */
export {
  DurabilityTracker,
  type DurabilityTrackerConfig,
  type TrackedHandle,
  type TrackedItem,
  type TrackedResult,
  type TrackedWaitOptions,
  type TrackerHandle,
  type TrackerPage,
  type TrackerQuery,
  type TrackerRecord,
  type TrackerRecordPage,
} from './tracker.js';
export type {
  TrackedEntry,
  TrackedPage,
  TrackedQuery,
  TrackedRecord,
  TrackedResults,
  TrackedSource,
  TrackedState,
  TrackedStatus,
} from './tracked-source.js';
export {
  DurabilityOutbox,
  type DurabilityOutboxConfig,
  type DurabilityOutboxEvent,
  type OutboxEntry,
} from './outbox.js';
export { OutboxTimeoutError } from './errors.js';
export { durabilityOutboxMigrations } from './migrations.js';
export {
  DurabilityTopology,
  type DurabilityTopologyConfig,
  type DurabilityTopologyEvent,
  type TopologyChannel,
  type TopologyCurrent,
  type TopologyDraft,
  type TopologyPublisher,
  type TopologyRetryOptions,
  type TopologyRole,
  type TopologyStateUpdate,
} from './topology.js';
export type {
  TopologyClient,
  TopologyClientConfig,
  TopologySource,
  TopologyView,
} from './topology-client.js';
export type {
  TopologyMember,
  TopologyMemberInput,
  TopologyMemberState,
  TopologySnapshot,
} from './topology-snapshot.js';
export {
  TopologyError,
  TopologyUnavailableError,
  type TopologyFallbackReason,
} from './errors.js';
export { durabilityTopologyMigrations } from './migrations.js';
