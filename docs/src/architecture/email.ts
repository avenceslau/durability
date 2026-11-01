import emailSource from '../../../examples/email-queue/worker.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture';

const file = 'examples/email-queue/worker.ts';

const consumer = sourceExcerpt(
  emailSource,
  file,
  'consumer',
  'EmailConsumer.consume',
  'export class EmailConsumer extends WorkerEntrypoint<Env> {',
  '// One bucket, two prefixes: every message is archived, failures are parked.'
);
const targets = sourceExcerpt(
  emailSource,
  file,
  'targets',
  'Fanout targets and DLQ',
  '    targets: {',
  '    retries: { maxAttempts: 5 },'
);
const enqueue = sourceExcerpt(
  emailSource,
  file,
  'enqueue',
  'Archive, DLQ, and enqueue',
  '      archive: {',
  '  override alarm(info?: AlarmInvocationInfo) {\n    return this.scheduler.alarm(info);\n  }\n}'
);
const routing = sourceExcerpt(
  emailSource,
  file,
  'routing',
  'Routing client and VIP lane',
  'export const routing = DurabilityRouting.client({',
  '      next({ context: { lane: name } })\n);'
);
const redrive = sourceExcerpt(
  emailSource,
  file,
  'redrive',
  'Accepted-target redrive',
  '      // This Worker wrote the entry; an application reading foreign data should',
  '      accepted += 1;'
);

export const emailWalkthrough = validateWalkthrough({
  id: 'email',
  title: 'Durable email fan-out',
  summary:
    'Routing selects one delivery object; fan-out records independent email and archive obligations before workers perform their target work.',
  width: 900,
  height: 420,
  nodes: [
    {
      id: 'client',
      title: 'Demo HTTP client',
      kind: 'compute',
      description:
        'The demo endpoint creates message inputs with generated identities; its VIP lane is routing context, not caller-request deduplication.',
      href: '/primitives/routing',
      x: 150,
      y: 80,
    },
    {
      id: 'routing',
      title: 'Routing client',
      kind: 'compute',
      description:
        'Computes a customer or lane shard and invokes one EmailDelivery object.',
      href: '/primitives/routing',
      x: 450,
      y: 80,
    },
    {
      id: 'delivery',
      title: 'EmailDelivery',
      kind: 'durable',
      description:
        'The Durable Object owns the scheduler, routing state, and durable fan-out obligations.',
      href: '/primitives/fanout',
      x: 750,
      y: 80,
    },
    {
      id: 'consumer',
      title: 'EmailConsumer',
      kind: 'compute',
      description:
        'A service worker receives email-target deliveries and settles each message after the provider response.',
      href: '/primitives/fanout',
      x: 750,
      y: 300,
    },
    {
      id: 'provider',
      title: 'Email provider',
      kind: 'external',
      description:
        'The provider is outside this Worker; it must deduplicate a repeated Idempotency-Key.',
      href: '/primitives/fanout',
      x: 450,
      y: 300,
    },
    {
      id: 'bucket',
      title: 'R2 archive and DLQ',
      kind: 'external',
      description:
        'The bucket holds archive objects and parked failed-target records; it is not the fan-out scheduler state.',
      href: '/primitives/fanout',
      x: 150,
      y: 300,
    },
  ],
  edges: [
    {
      id: 'invoke',
      from: 'client',
      to: 'routing',
      label: 'push with VIP lane',
    },
    {
      id: 'route',
      from: 'routing',
      to: 'delivery',
      label: 'invoke enqueue on shard',
    },
    {
      id: 'register',
      from: 'delivery',
      to: 'consumer',
      label: 'durable email obligation',
    },
    {
      id: 'archive',
      from: 'delivery',
      to: 'bucket',
      label: 'independent archive obligation',
    },
    {
      id: 'send',
      from: 'consumer',
      to: 'provider',
      label: 'send with message ID',
    },
    {
      id: 'ack',
      from: 'consumer',
      to: 'delivery',
      label: 'await acknowledgement',
    },
    {
      id: 'park',
      from: 'delivery',
      to: 'bucket',
      label: 'persist failed target',
    },
  ],
  excerpts: [consumer, targets, enqueue, routing, redrive],
  scenarios: [
    {
      id: 'delivery',
      title: 'Register and deliver',
      description:
        'The archive and email targets are separate obligations, so archive completion is not a prerequisite for sending.',
      steps: [
        {
          id: 'shard',
          title: 'Select the delivery shard',
          description:
            'The routing client invokes enqueue on the object selected from the lane or customer key.',
          nodes: ['client', 'routing', 'delivery'],
          edges: ['invoke', 'route'],
          source: sourceFocus(
            routing,
            '  invoke: (stub, batch: Batch) => stub.enqueue(batch),'
          ),
          durable: 'No email obligation yet; this is an invocation decision.',
          volatile:
            'The client carries the demo VIP lane and batch while making the call.',
          status: 'normal',
        },
        {
          id: 'register',
          title: 'Wire independent destinations',
          description:
            'This configuration defines email and archive as independent recipients. Wiring callbacks is not itself message acceptance, and neither target is ordered before the other.',
          nodes: ['delivery', 'consumer', 'bucket'],
          edges: ['register', 'archive'],
          source: sourceFocus(targets, '    targets: {', '    },\n    dlq:'),
          durable:
            'No message is inserted by configuration; accepted messages will snapshot these target IDs.',
          volatile:
            'The live object holds callbacks for its configured target IDs.',
          status: 'normal',
        },
        {
          id: 'accept',
          title: 'Accept the batch durably',
          description:
            'This call is the actual registration boundary: fanout atomically stores manifests and independent target obligations before returning acceptance.',
          nodes: ['delivery', 'consumer', 'bucket'],
          edges: ['register', 'archive'],
          source: sourceFocus(
            enqueue,
            'return this.fanout.enqueue(batch.messages, batch.options);'
          ),
          durable:
            'Once enqueue commits, both target obligations can survive object eviction.',
          volatile:
            'The original HTTP request need not stay alive for target delivery.',
          status: 'commit',
        },
        {
          id: 'send',
          title: 'Call the provider',
          description:
            'The consumer sends the message ID as the provider idempotency key. The source does not implement provider deduplication.',
          nodes: ['consumer', 'provider'],
          edges: ['send'],
          source: sourceFocus(
            consumer,
            '      const response = await this.env.EMAIL_API.fetch(',
            '      );'
          ),
          durable:
            'The email obligation remains unsettled while the provider call is in flight.',
          volatile:
            'The response and message batch are held by this consumer invocation.',
          status: 'normal',
        },
        {
          id: 'ack',
          title: 'Acknowledge after success',
          description:
            'A successful response is followed by an awaited acknowledgement, completing the email target.',
          nodes: ['consumer', 'delivery'],
          edges: ['ack'],
          source: sourceFocus(consumer, '        await message.ack();'),
          durable:
            'The email target is settled; the archive target follows its own completion path.',
          volatile:
            'The consumer can release this message after the await returns.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'lost-ack',
      title: 'Provider effect before acknowledgement',
      description:
        'This is the at-least-once duplicate-effect window, not a claim that the Worker can undo or reconcile a provider send.',
      steps: [
        {
          id: 'attempt',
          title: 'Issue the first send',
          description:
            'The provider can accept the request before the local acknowledgement is made.',
          nodes: ['consumer', 'provider'],
          edges: ['send'],
          source: sourceFocus(
            consumer,
            '      const response = await this.env.EMAIL_API.fetch(',
            '      );'
          ),
          durable: 'The email obligation is still pending.',
          volatile: 'The invocation has the provider response in memory.',
          status: 'normal',
        },
        {
          id: 'crash',
          title: 'Crash before ack',
          description:
            'If execution stops after the provider effect and before ack, no settlement has been persisted.',
          nodes: ['consumer', 'provider', 'delivery'],
          edges: ['send', 'ack'],
          source: sourceFocus(
            consumer,
            '      const response = await this.env.EMAIL_API.fetch(',
            '      );'
          ),
          durable:
            'The pending email obligation survives; no acknowledgement exists.',
          volatile: 'The response is lost with the stopped invocation.',
          status: 'failure',
        },
        {
          id: 'replay',
          title: 'Redeliver the pending message',
          description:
            'The same message may be sent again because its durable target was not settled.',
          nodes: ['delivery', 'consumer', 'provider'],
          edges: ['register', 'send'],
          source: sourceFocus(
            consumer,
            '      const response = await this.env.EMAIL_API.fetch(',
            '      );'
          ),
          durable:
            'The original email obligation remains the one being retried.',
          volatile: 'A new consumer invocation owns the redelivery.',
          status: 'recovery',
        },
        {
          id: 'deduplicate',
          title: 'Provider deduplicates the repeated key',
          description:
            'If the external provider truly honors this key, it returns the prior outcome. Otherwise this retry can send a second email; the consumer cannot guarantee provider deduplication.',
          nodes: ['consumer', 'provider', 'delivery'],
          edges: ['send', 'ack'],
          source: sourceFocus(consumer, '        await message.ack();'),
          durable: 'After ack, the email target is settled.',
          volatile:
            'Provider-side idempotency state is external to this example.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'redrive',
      title: 'Redrive one parked target',
      description:
        'After target retries exhaust, redrive re-enqueues only the failed target and deletes its R2 entry only after acceptance.',
      steps: [
        {
          id: 'park',
          title: 'Park the failed target',
          description:
            'The configured DLQ callback writes the failed target entry to R2 before an operator redrives it.',
          nodes: ['delivery', 'bucket'],
          edges: ['park'],
          source: sourceFocus(
            enqueue,
            '    dlq: async (message) => {',
            '    },'
          ),
          durable:
            'A DLQ object records the failed target; unrelated archive or email targets are not redriven.',
          volatile: 'The failed delivery attempt has ended.',
          status: 'failure',
        },
        {
          id: 'read',
          title: 'Read the parked entry',
          description:
            'Administrative code reads a stored entry and preserves its target identity.',
          nodes: ['bucket', 'routing'],
          edges: ['park'],
          source: sourceFocus(
            redrive,
            'const entry = (await stored.json()) as StoredMessage<Email>;'
          ),
          durable:
            'The DLQ object remains until a target-specific push is accepted.',
          volatile: 'The administrator loop has one decoded entry.',
          status: 'normal',
        },
        {
          id: 'accept',
          title: 'Re-enqueue only that target',
          description:
            'The push explicitly names the recorded target; it does not replay sibling obligations.',
          nodes: ['routing', 'delivery', 'consumer'],
          edges: ['route', 'register'],
          source: sourceFocus(
            redrive,
            'const result = await routing.push({',
            '});'
          ),
          durable:
            'A newly accepted failed-target obligation exists; the DLQ object is still present.',
          volatile:
            'The redrive result is held while the loop decides whether deletion is safe.',
          status: 'commit',
        },
        {
          id: 'delete',
          title: 'Delete only after acceptance',
          description:
            'Rejection or uncertainty keeps the entry. A crash between acceptance and deletion can duplicate work.',
          nodes: ['bucket', 'delivery'],
          edges: ['park'],
          source: sourceFocus(
            redrive,
            'await env.DEAD_LETTERS.delete(object.key);'
          ),
          durable:
            'The accepted entry is removed only after the delete completes.',
          volatile: 'The loop advances its accepted count.',
          status: 'recovery',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
