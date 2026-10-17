import type { Dashboard } from './dashboard';
import type { Pipeline } from './pipeline';

export type Env = {
  PIPELINE: DurableObjectNamespace<Pipeline>;
  DASHBOARD: DurableObjectNamespace<Dashboard>;
  ORDERS: Fetcher;
};

export type OrderSummary = { orderId: string; total: number };

/** Result type of each job name, as the dashboard's tracked source reports it. */
export type Jobs = { importOrder: OrderSummary };

/** One durable message from the pipeline to the dashboard. */
export type JobEvent = {
  /** The operation's idempotency key. */
  id: string;
  name: keyof Jobs;
  /** Changes when the id is reused for new work; the dashboard keeps the newest. */
  generation: string;
  createdAt: number;
  state:
    | { status: 'pending' }
    | { status: 'completed'; result: OrderSummary }
    | { status: 'failed'; error: { name: string; message: string } };
};
