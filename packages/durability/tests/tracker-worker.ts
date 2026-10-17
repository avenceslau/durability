import { DurableObject } from 'cloudflare:workers';
import { newWorkersRpcResponse, RpcTarget } from 'capnweb';
import { Durability, type DurableCall } from '../src';
import { DurabilityTracker } from '../src/experimental';

export class TrackerTestObject extends DurableObject {
  private readonly gates = new Map<string, () => void>();

  private readonly durability = new Durability({
    context: this.ctx,
    handlers: {
      resize: async ({ id, payload }: DurableCall<{ size: number }>) => {
        await new Promise<void>((resolve) => {
          this.gates.set(id, resolve);
        });
        return payload.size * 2;
      },
    },
  });

  private readonly tracker = new DurabilityTracker({
    sources: { jobs: this.durability },
  });

  start(id: string, size: number) {
    return this.durability.resize({ id, payload: { size } });
  }

  async startAndTrack(id: string, size: number) {
    await this.start(id, size);
    const handle = await this.tracker.get('jobs', id);
    if (!handle) {
      throw new Error(`Job "${id}" was not registered`);
    }
    return handle;
  }

  listWork() {
    return this.tracker.list();
  }

  release(id: string): boolean {
    const release = this.gates.get(id);
    release?.();
    return release !== undefined;
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }

  override fetch(request: Request) {
    return newWorkersRpcResponse(request, new TrackerApi(this));
  }
}

export class TrackerApi extends RpcTarget {
  constructor(private readonly object: TrackerTestObject) {
    super();
  }

  listWork() {
    return this.object.listWork();
  }
}
