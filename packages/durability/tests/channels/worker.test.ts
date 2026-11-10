import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { ChannelsTestObject } from './worker';

declare global {
  namespace Cloudflare {
    interface Env {
      CHANNELS_TEST: DurableObjectNamespace<ChannelsTestObject>;
    }
  }
}

describe('operation channels in workerd', () => {
  // Node 22's node:sqlite truncates returned TEXT at NUL; exercise these IDs
  // against Durable Object storage rather than the Node-backed FakeStorage.
  it.each(['\u0000key', 'key\u0000suffix', 'key\u0000'])(
    'preserves the exact ID %j across channels',
    async (id) => {
      const stub = env.CHANNELS_TEST.get(env.CHANNELS_TEST.newUniqueId());
      const result = await stub.run(id);
      expect(result.app).toEqual({
        status: 'completed',
        result: { channel: 'default', id },
      });
      expect(result.library).toEqual({
        status: 'completed',
        result: { channel: 'library', id },
      });
      expect(
        result.records.map(({ source, id: callId }) => [source, callId])
      ).toEqual([
        ['app', id],
        ['library', id],
      ]);
    }
  );
});
