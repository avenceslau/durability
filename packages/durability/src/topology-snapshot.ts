import { z } from 'zod';

/** `active` members are in the write and read sets; `draining` members only in the read set. */
export type TopologyMemberState = 'active' | 'draining';

type MetaField<Meta> = undefined extends Meta
  ? { meta?: Meta }
  : { meta: Meta };

/** A member as the application declares it. */
export type TopologyMemberInput<Meta = undefined> = {
  /** The member's Durable Object name. */
  id: string;
  state: TopologyMemberState;
  locationHint?: DurableObjectLocationHint;
} & MetaField<Meta>;

export type TopologyMember<Meta = undefined> = TopologyMemberInput<Meta> & {
  joinedAt: number;
};

export type TopologySnapshot<Meta = undefined> = {
  group: string;
  /** Increases on every membership change, and keeps increasing across deletes. */
  version: number;
  /** ID of the Durable Object whose topology published this snapshot. */
  holder: string;
  /** Sorted by ID. */
  members: readonly TopologyMember<Meta>[];
};

const locationHints = [
  'wnam',
  'enam',
  'sam',
  'weur',
  'eeur',
  'apac',
  'oc',
  'afr',
  'me',
] as const satisfies readonly DurableObjectLocationHint[];

// Unknown keys are stripped, so current members (which carry `joinedAt`) can be returned as input.
export const memberInputSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['active', 'draining']),
  locationHint: z.enum(locationHints).optional(),
  meta: z.json().optional(),
});

const memberSchema = memberInputSchema.extend({
  joinedAt: z.number().int().nonnegative(),
});

export const membersSchema = memberSchema
  .array()
  .superRefine((members, ctx) => {
    for (let index = 1; index < members.length; index++) {
      if (members[index - 1]!.id >= members[index]!.id) {
        ctx.addIssue({
          code: 'custom',
          message: 'Members must be sorted by ID and unique',
          path: [index, 'id'],
        });
      }
    }
  });

const encodedSchema = z.object({
  format: z.literal(1),
  group: z.string().min(1),
  version: z.number().int().positive(),
  holder: z.string().min(1),
  members: membersSchema.min(1),
});

export const encodeSnapshot = <Meta>(
  snapshot: TopologySnapshot<Meta>
): string => JSON.stringify({ format: 1, ...snapshot });

/** The stored value crossed a trust boundary, so every field is re-validated. */
export const decodeSnapshot = <Meta>(
  encoded: string
): TopologySnapshot<Meta> => {
  const { format: _format, ...snapshot } = encodedSchema.parse(
    JSON.parse(encoded)
  );
  return snapshot as unknown as TopologySnapshot<Meta>;
};
