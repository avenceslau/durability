import * as v from 'valibot';
import { jsonSchema } from '../serialization.js';

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
  /** ID of the coordinator Durable Object that published this snapshot. */
  coordinator: string;
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
export const memberInputSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  state: v.picklist(['active', 'draining']),
  locationHint: v.optional(v.picklist(locationHints)),
  meta: v.optional(jsonSchema),
});

const memberSchema = v.object({
  ...memberInputSchema.entries,
  joinedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export const membersSchema = v.pipe(
  v.array(memberSchema),
  v.check(
    (members) =>
      members.every(
        (member, index) => index === 0 || members[index - 1]!.id < member.id
      ),
    'Members must be sorted by ID and unique'
  )
);

const encodedSchema = v.object({
  format: v.literal(1),
  group: v.pipe(v.string(), v.minLength(1)),
  version: v.pipe(v.number(), v.safeInteger(), v.gtValue(0)),
  coordinator: v.pipe(v.string(), v.minLength(1)),
  members: v.pipe(membersSchema, v.minLength(1)),
});

export const encodeSnapshot = <Meta>(
  snapshot: TopologySnapshot<Meta>
): string => JSON.stringify({ format: 1, ...snapshot });

/** The stored value crossed a trust boundary, so every field is re-validated. */
export const decodeSnapshot = <Meta>(
  encoded: string
): TopologySnapshot<Meta> => {
  const { format: _format, ...snapshot } = v.parse(
    encodedSchema,
    JSON.parse(encoded)
  );
  return snapshot as unknown as TopologySnapshot<Meta>;
};
