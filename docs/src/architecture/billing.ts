import source from '../../../examples/subscription-renewals/worker.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture';

const file = 'examples/subscription-renewals/worker.ts';
const subscribe = sourceExcerpt(
  source,
  file,
  'subscribe',
  'Subscribe and schedule',
  '  async subscribe(customerId: string)',
  '    await this.alarms.renew(Date.now() + renewalPeriodMs);\n  }'
);
const renew = sourceExcerpt(
  source,
  file,
  'renew',
  'Renewal → operation handoff',
  '      renew: async ({ idempotencyKey, scheduledTime })',
  '        await this.alarms.renew(scheduledTime + renewalPeriodMs);\n      },'
);
const charge = sourceExcerpt(
  source,
  file,
  'charge',
  'Charge with a stable key',
  '      chargeInvoice: async ({ id, payload }',
  '    retries: { maxAttempts: 8 },\n  });'
);
const scheduler = sourceExcerpt(
  source,
  file,
  'scheduler',
  'One physical alarm owner',
  '  private readonly scheduler = new DurabilityScheduler(',
  '    alarmConcurrency: 5,\n  });'
);

export const billingWalkthrough = validateWalkthrough({
  id: 'billing',
  title: 'Follow a renewal from code to architecture',
  summary:
    'The renewal clock, durable payment work, and external payment outcome have separate persistence boundaries. Step through their handoffs, then lose an acknowledgement.',
  width: 900,
  height: 390,
  nodes: [
    {
      id: 'subscription',
      title: 'Subscription RPC',
      kind: 'compute',
      x: 150,
      y: 80,
      description:
        'Application-owned object. subscribe() writes customer state and schedules renew; neither action waits for a payment.',
      href: '/compositions/recurring-billing/',
    },
    {
      id: 'storage',
      title: 'Object SQLite',
      kind: 'durable',
      x: 450,
      y: 80,
      description:
        'Customer data and helper records survive eviction. The example writes customerId and schedules the alarm separately, not in one application transaction.',
      href: '/reference/migrations/',
    },
    {
      id: 'scheduler',
      title: 'Shared scheduler',
      kind: 'memory',
      x: 750,
      y: 80,
      description:
        'One in-memory engine and permit pool manages the object’s durable physical alarm. The physical alarm, unlike the live engine, survives eviction.',
      href: '/primitives/scheduler/',
    },
    {
      id: 'renewal',
      title: 'Named renewal',
      kind: 'durable',
      x: 150,
      y: 300,
      description:
        'The stored occurrence has its own stable idempotencyKey. Replacing the name creates a new occurrence, not a second copy of the same clock event.',
      href: '/primitives/alarms/',
    },
    {
      id: 'operation',
      title: 'Charge operation',
      kind: 'durable',
      x: 450,
      y: 300,
      description:
        'The occurrence key becomes the operation ID. Registration persists work; attempts and results are tracked independently of the renewal alarm.',
      href: '/primitives/operations/',
    },
    {
      id: 'provider',
      title: 'Payment receiver',
      kind: 'external',
      x: 750,
      y: 300,
      description:
        'A separate system must enforce Idempotency-Key at its actual charge boundary. This example only forwards the header; it cannot implement that guarantee for the provider.',
      href: '/reference/guarantees/',
    },
  ],
  edges: [
    {
      id: 'store',
      from: 'subscription',
      to: 'storage',
      label: 'write customer',
    },
    {
      id: 'schedule',
      from: 'storage',
      to: 'renewal',
      label: 'persist occurrence',
    },
    { id: 'wake', from: 'scheduler', to: 'renewal', label: 'run due renewal' },
    {
      id: 'register',
      from: 'renewal',
      to: 'operation',
      label: 'register stable ID',
    },
    {
      id: 'execute',
      from: 'scheduler',
      to: 'operation',
      label: 'claim attempt',
    },
    { id: 'send', from: 'operation', to: 'provider', label: 'charge with key' },
  ],
  excerpts: [subscribe, renew, charge, scheduler],
  scenarios: [
    {
      id: 'renewal',
      title: 'A normal renewal',
      description:
        'Follow the code that connects the clock, durable job, and payment receiver.',
      steps: [
        {
          id: 'pool',
          title: 'Share the object’s execution budget',
          description:
            'Both helpers attach to this one scheduler. Its five live permits belong to this object, not to all customers globally.',
          nodes: ['scheduler'],
          edges: ['wake', 'execute'],
          source: sourceFocus(
            scheduler,
            'private readonly scheduler',
            'alarmConcurrency: 5,'
          ),
          durable:
            'Attached helpers will persist their work and reconcile the object’s physical alarm.',
          volatile:
            'The shared scheduler and its permit pool are created for this live instance.',
          status: 'normal',
        },
        {
          id: 'subscribe',
          title: 'Persist the subscription',
          description:
            'This storage write belongs to the subscription object. Scheduling the renewal is a separate await in this recipe, so production code still needs to address that handoff gap.',
          nodes: ['subscription', 'storage'],
          edges: ['store'],
          source: sourceFocus(
            subscribe,
            "await this.ctx.storage.put('customerId', customerId)"
          ),
          durable: 'customerId is stored when this await resolves.',
          volatile:
            'The RPC stack is live; no payment handler has to be running.',
          status: 'commit',
        },
        {
          id: 'schedule',
          title: 'Give the clock durable intent',
          description:
            'The generated renew method persists a named occurrence and reconciles the physical alarm. It does not sleep inside this request for 30 days.',
          nodes: ['storage', 'renewal', 'scheduler'],
          edges: ['schedule', 'wake'],
          source: sourceFocus(
            subscribe,
            'await this.alarms.renew(Date.now() + renewalPeriodMs)'
          ),
          durable: 'The occurrence and alarm fallback can survive eviction.',
          volatile:
            'Near-due timers are only an optimization; timers do not survive eviction.',
          status: 'commit',
        },
        {
          id: 'register',
          title: 'Hand off to payment work',
          description:
            'When renew runs, its occurrence key becomes the charge operation ID. Awaiting this method waits for registration, not for a successful charge.',
          nodes: ['renewal', 'operation'],
          edges: ['register'],
          source: sourceFocus(
            renew,
            'await this.durability.chargeInvoice({',
            'payload: { customerId, periodStart: scheduledTime },'
          ),
          durable:
            'A deduplicated charge operation exists after registration commits.',
          volatile:
            'The renewal handler may finish while the charge is still pending.',
          status: 'commit',
        },
        {
          id: 'rearm',
          title: 'Advance the renewal clock',
          description:
            'The next occurrence is based on scheduledTime. Payment retries are independent; this line does not wait for their result. Thirty days is a fixed interval, not a calendar month.',
          nodes: ['renewal', 'scheduler'],
          edges: ['wake'],
          source: sourceFocus(
            renew,
            'await this.alarms.renew(scheduledTime + renewalPeriodMs)'
          ),
          durable:
            'The next named occurrence replaces the current scheduling record.',
          volatile:
            'The old handler’s generation-fenced settlement cannot delete its replacement.',
          status: 'normal',
        },
        {
          id: 'charge',
          title: 'Cross the external boundary',
          description:
            'The operation forwards its stable ID. The provider must really deduplicate that key; sending a header is not itself an exactly-once guarantee.',
          nodes: ['scheduler', 'operation', 'provider'],
          edges: ['execute', 'send'],
          source: sourceFocus(
            charge,
            'headers:',
            'body: JSON.stringify(payload),'
          ),
          durable:
            'The operation record and the provider’s own charge record are separate commits.',
          volatile: 'An active fetch and its acknowledgement can be lost.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'lost-ack',
      title: 'Lose the payment acknowledgement',
      description:
        'An illustrative failure at the external boundary, not execution of the example code.',
      steps: [
        {
          id: 'effect',
          title: 'The receiver commits the charge',
          description:
            'Assume the provider commits the effect and its idempotency record, but the object stops before local completion is recorded. The highlighted fetch is where that uncertainty enters.',
          nodes: ['operation', 'provider'],
          edges: ['send'],
          source: sourceFocus(
            charge,
            'const response = await this.env.PAYMENTS.fetch('
          ),
          durable:
            'The charge may exist remotely; the local operation can still be pending.',
          volatile: 'The response and live attempt disappear on interruption.',
          status: 'failure',
        },
        {
          id: 'retry',
          title: 'Retry the same logical charge',
          description:
            'The durable operation engine can reconstruct the pending attempt. The same stored ID is forwarded again, rather than minting a new payment identity.',
          nodes: ['storage', 'scheduler', 'operation', 'provider'],
          edges: ['execute', 'send'],
          source: sourceFocus(charge, "headers: { 'Idempotency-Key': id }"),
          durable:
            'The stored operation identity survives; retries use it until the policy settles.',
          volatile:
            'A new live attempt replaces the lost promise, not the remote business effect.',
          status: 'recovery',
        },
        {
          id: 'boundary',
          title: 'The receiver decides whether it is safe',
          description:
            'A key-aware provider returns its prior outcome. A provider that ignores the key can charge twice. Nothing in this highlighted caller code closes that cross-system transaction.',
          nodes: ['provider', 'operation'],
          edges: ['send'],
          source: sourceFocus(charge, "headers: { 'Idempotency-Key': id }"),
          durable:
            'Effectively-once charging requires the receiver’s authoritative deduplication record.',
          volatile:
            'No in-memory flag or attempt number can prove what the receiver committed.',
          status: 'gap',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
