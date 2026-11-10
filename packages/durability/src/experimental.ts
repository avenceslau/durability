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
} from './tracker/index.js';
export type {
  TrackedEntry,
  TrackedPage,
  TrackedQuery,
  TrackedRecord,
  TrackedResults,
  TrackedSource,
  TrackedState,
  TrackedStatus,
} from './tracker/source.js';
export {
  DurabilityOutbox,
  type DurabilityOutboxConfig,
  type DurabilityOutboxEvent,
  type OutboxEntry,
} from './outbox/index.js';
export { OutboxTimeoutError } from './errors.js';
export { durabilityOutboxMigrations } from './outbox/migrations.js';
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
} from './topology/index.js';
export type {
  TopologyClient,
  TopologyClientConfig,
  TopologySource,
  TopologyView,
} from './topology/client.js';
export type {
  TopologyMember,
  TopologyMemberInput,
  TopologyMemberState,
  TopologySnapshot,
} from './topology/snapshot.js';
export {
  TopologyError,
  TopologyUnavailableError,
  type TopologyFallbackReason,
} from './errors.js';
export { durabilityTopologyMigrations } from './topology/migrations.js';
export {
  DurabilitySchedule,
  type DurabilityScheduleConfig,
  type DurabilityScheduleEvent,
  type ScheduleDefinition,
  type ScheduledOutcomeDelivery,
  type ScheduledRun,
  type ScheduledRunContext,
  type ScheduledRunOutcome,
  type ScheduleState,
} from './schedule/index.js';
export {
  ScheduledOutcomeTimeoutError,
  ScheduledRunInterruptedError,
  ScheduledRunTimeoutError,
} from './errors.js';
export { durabilityScheduleMigrations } from './schedule/migrations.js';
