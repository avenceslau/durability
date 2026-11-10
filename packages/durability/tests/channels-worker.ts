import { DurableObject } from 'cloudflare:workers';
import { Durability, type DurableCall } from '../src';
import { DurabilityTracker } from '../src/experimental';

export class ChannelsTestObject extends DurableObject {
  private readonly app = new Durability({
    context: this.ctx,
    handlers: {
      work: ({ id }: DurableCall<null>) => ({ channel: 'default', id }),
    },
  });

  private readonly library = new Durability({
    context: this.ctx,
    channel: 'library',
    handlers: {
      work: ({ id }: DurableCall<null>) => ({ channel: 'library', id }),
    },
  });

  private readonly tracker = new DurabilityTracker({
    sources: { app: this.app, library: this.library },
  });

  async run(id: string) {
    await this.app.work({ id, payload: null });
    await this.library.work({ id, payload: null });
    await this.app.alarm();
    return {
      app: await this.app.work.getResult(id),
      library: await this.library.work.getResult(id),
      records: (await this.tracker.records()).records,
    };
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.app.alarm(info);
  }
}
