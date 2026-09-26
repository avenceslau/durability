import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutingLoad } from './load';

afterEach(() => vi.useRealTimers());

describe('rolling routing load', () => {
  it('counts completed calls and averages the same samples without using RPS', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const load = new RoutingLoad();
    expect(load.snapshot(3).inbound).toEqual({
      inFlight: 0,
      completed: 0,
      averageProcessingMs: null,
    });
    const first = load.begin('inbound');
    vi.advanceTimersByTime(10);
    const second = load.begin('inbound');
    vi.advanceTimersByTime(20);
    first();
    first();
    expect(load.snapshot(3).inbound).toEqual({
      inFlight: 1,
      completed: 1,
      averageProcessingMs: 30,
    });
    vi.advanceTimersByTime(20);
    second();
    expect(load.snapshot(3)).toMatchObject({
      windowMs: 60_000,
      inbound: { inFlight: 0, completed: 2, averageProcessingMs: 35 },
      outbound: {
        pendingDeliveries: 3,
        completed: 0,
        averageProcessingMs: null,
      },
    });
  });

  it('expires old samples but retains active requests across the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const load = new RoutingLoad();
    load.begin('outbound')();
    const finish = load.begin('outbound');
    vi.advanceTimersByTime(60_000);
    expect(load.snapshot(2).outbound).toEqual({
      pendingDeliveries: 2,
      inFlight: 1,
      completed: 0,
      averageProcessingMs: null,
    });
    finish();
    expect(load.snapshot(1).outbound).toEqual({
      pendingDeliveries: 1,
      inFlight: 0,
      completed: 1,
      averageProcessingMs: 60_000,
    });
    expect(
      new RoutingLoad().snapshot(1).outbound.averageProcessingMs
    ).toBeNull();
  });
});
