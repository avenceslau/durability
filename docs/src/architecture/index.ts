import { billingWalkthrough } from './billing';
import { emailWalkthrough } from './email';
import { dashboardWalkthrough } from './dashboard';
import { concurrencyWalkthrough } from './concurrency';
import { eventStreamWalkthrough } from './event-stream';

export const walkthroughs = {
  billing: billingWalkthrough,
  email: emailWalkthrough,
  dashboard: dashboardWalkthrough,
  concurrency: concurrencyWalkthrough,
  'event-stream': eventStreamWalkthrough,
};

export type WalkthroughExample = keyof typeof walkthroughs;
