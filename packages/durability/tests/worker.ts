import socketWorker, { SocketTestObject } from './socket/worker';
export { SocketTestObject };
export { NamedAlarmTestObject } from './alarms/worker';
export { DeliveryObject, FanoutConsumer } from './fanout/worker';
export { LogTestObject } from './log/worker';
export { TrackerTestObject } from './tracker/worker';
export { ChannelsTestObject } from './channels/worker';
export { OutboxObject } from './outbox/worker';
export { JobShard, LimitObject } from './semaphore/worker';
export { TopologyCoordinator, TopologyShard } from './topology/worker';
export { LiveScheduleObject, ScheduleObject } from './schedule/worker';
export { LiveTimersObject } from './live-timers/worker';

export default {
  fetch(request: Request, env: Parameters<typeof socketWorker.fetch>[1]) {
    if (new URL(request.url).pathname.startsWith('/socket/')) {
      return socketWorker.fetch(request, env);
    }
    return new Response('Not found', { status: 404 });
  },
};
