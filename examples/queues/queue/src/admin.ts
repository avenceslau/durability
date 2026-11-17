/**
 * Creating and configuring queues. The HTTP admin API and the `QueueAdmin`
 * entrypoint both go through here, so they validate and default alike.
 */
import * as v from 'valibot';
import {
  queueNameSchema,
  settingsInputSchema,
  targetInputSchema,
  targetNameSchema,
  targetsInputSchema,
  type Overview,
  type QueueSummary,
} from './model';
import { directory, orchestrators } from './namespaces';

export type SettingsInput = v.InferInput<typeof settingsInputSchema>;
export type TargetInput = v.InferInput<typeof targetInputSchema>;

const orchestrator = (queue: string) =>
  orchestrators().getByName(v.parse(queueNameSchema, queue));

export const listQueues = () => directory().list();

export const createQueue = async (
  queue: string,
  settings: SettingsInput = {},
  targets: Record<string, TargetInput> = {}
): Promise<void> => {
  await orchestrator(queue).create(
    queue,
    v.parse(settingsInputSchema, settings),
    v.parse(targetsInputSchema, targets)
  );
  await directory().add(queue);
};

/** Changes the settings that are given and keeps the rest. */
export const updateSettings = async (
  queue: string,
  changes: SettingsInput
): Promise<void> => {
  const { settings } = await orchestrator(queue).overview();
  await orchestrator(queue).updateSettings(
    v.parse(settingsInputSchema, {
      ...settings,
      ...changes,
      partitions: { ...settings.partitions, ...changes.partitions },
    })
  );
};

export const deleteQueue = async (queue: string): Promise<void> => {
  await orchestrator(queue).delete();
  await directory().remove(queue);
};

export const putTarget = (
  queue: string,
  target: string,
  settings: TargetInput
): Promise<void> =>
  orchestrator(queue).putTarget(
    v.parse(targetNameSchema, target),
    v.parse(targetInputSchema, settings)
  );

export const removeTarget = (queue: string, target: string): Promise<void> =>
  orchestrator(queue).removeTarget(v.parse(targetNameSchema, target));

export const pauseTarget = (
  queue: string,
  target: string,
  paused: boolean
): Promise<void> =>
  orchestrator(queue).pauseTarget(v.parse(targetNameSchema, target), paused);

export const resize = (queue: string, partitions: number): Promise<void> =>
  orchestrator(queue).resize(
    v.parse(v.pipe(v.number(), v.safeInteger(), v.minValue(1)), partitions)
  );

/** Every queue's latest numbers. One that cannot answer is left out. */
export const summaries = async (): Promise<QueueSummary[]> => {
  const queues = await directory().list();
  const found = await Promise.all(
    queues.map(({ name }) =>
      orchestrators()
        .getByName(name)
        .summary()
        .catch(() => undefined)
    )
  );
  return found.filter((summary) => summary !== undefined);
};

export const overview = (queue: string): Promise<Overview> =>
  orchestrator(queue).overview();
