/**
 * Browser side of the `job-dashboard` example. Loads a snapshot of tracked
 * work through `work`, applies `job` events as they arrive, and starts
 * imports through the dashboard, which waits on the pipeline for the result.
 */
import { DurabilitySocketClient } from 'durability/client';
import type { TrackedListRecord } from 'durability/experimental';
import type { Dashboard } from './dashboard';
import type { Jobs } from './shared';

const client = new DurabilitySocketClient<Dashboard['socket']>({
  url: (tenant) => `wss://jobs.example.com/tenants/${tenant}/ws`,
});

export const openDashboard = (
  tenant: string,
  render: (jobs: TrackedListRecord<Jobs>[]) => void
) => {
  const conn = client.connect(tenant);
  const jobs = new Map<string, TrackedListRecord<Jobs>>();

  const reload = async () => {
    jobs.clear();
    let cursor: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await conn.rpc.work({ cursor });
      for (const record of page.records) {
        jobs.set(record.id, record);
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    render([...jobs.values()]);
  };

  // Fires on first connect and whenever missed events could not be replayed.
  conn.on.resync(() => void reload());
  conn.on.job((record) => {
    jobs.set(record.id, record);
    render([...jobs.values()]);
  });

  return {
    /** Resolves with the job's outcome; other tabs see it through `job`. */
    importOrder: (orderId: string) => conn.rpc.importOrder(orderId),
    close: () => conn.close(),
  };
};
