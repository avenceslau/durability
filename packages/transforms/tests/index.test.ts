import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  applyTransforms,
  createTransformContextTarget,
  createTransformStub,
  defineTransform,
  registerTransform,
  withTransforms,
} from '../src/index';

type ObservabilityContext = {
  requestId?: string;
};

type TestEnv = {
  metrics: {
    increment(name: string, labels: { requestId?: string }): void;
  };
};

class TestDO {
  readonly ctx = {};

  constructor(readonly env: TestEnv) {}

  setContext(context: ObservabilityContext) {
    return createTransformContextTarget(this, context);
  }

  async greet(name: string) {
    return `Hello, ${name}`;
  }
}

const observability = defineTransform<TestDO, ObservabilityContext>()
  .caller(
    (options: { requestId: string }) =>
      async ({ next }) =>
        next({ context: { requestId: options.requestId } })
  )
  .callee(
    (options: { metricName: string }) =>
      async ({ context, env, next }) => {
        env.metrics.increment(
          options.metricName,
          context.requestId === undefined
            ? {}
            : { requestId: context.requestId }
        );

        return next();
      }
  );

applyTransforms(TestDO, {
  all: [registerTransform(observability, { metricName: 'do_rpc_calls' })],
  methods: {
    greet: [registerTransform(observability, { metricName: 'greet_calls' })],
  },
});

function assertRegistrationTypes() {
  // @ts-expect-error callee options are required
  registerTransform(observability);
  // @ts-expect-error callee options must match
  registerTransform(observability, { metricName: 1 });
  registerTransform(observability, {
    metricName: 'calls',
    // @ts-expect-error callee options reject unknown properties
    extra: true,
  });

  class OtherDO {
    setContext(context: ObservabilityContext) {
      return createTransformContextTarget(this, context);
    }

    async greet() {
      return 'other';
    }
  }

  const otherTransform = defineTransform<
    OtherDO,
    ObservabilityContext
  >().callee(
    (_options: { enabled: boolean }) =>
      async ({ next }) =>
        next()
  );
  const otherRegistration = registerTransform(otherTransform, {
    enabled: true,
  });

  applyTransforms(TestDO, {
    // @ts-expect-error transform targets OtherDO
    all: [otherRegistration],
  });

  const incompatibleContext = defineTransform<
    TestDO,
    { accountId: string }
  >().callee(
    (_options: { enabled: boolean }) =>
      async ({ next }) =>
        next()
  );
  const incompatibleContextRegistration = registerTransform(
    incompatibleContext,
    { enabled: true }
  );
  applyTransforms(TestDO, {
    // @ts-expect-error transform context is incompatible with setContext
    all: [incompatibleContextRegistration],
  });

  applyTransforms(TestDO, {
    methods: {
      // @ts-expect-error method does not exist
      missing: [],
    },
  });

  class InvalidContextTarget {
    setContext(_context: ObservabilityContext) {}

    async greet() {
      return 'hello';
    }
  }
  const invalidStub = withTransforms({
    get: () => new InvalidContextTarget(),
  }).get();
  invalidStub.with(
    // @ts-expect-error setContext must return an invokable context target
    observability,
    { requestId: 'request-1' }
  );

  class AsyncContextTarget {
    async setContext(context: ObservabilityContext) {
      return createTransformContextTarget(this, context);
    }

    async greet() {
      return 'hello';
    }
  }
  const asyncContextStub = withTransforms({
    get: () => new AsyncContextTarget(),
  }).get();
  asyncContextStub.with(
    // @ts-expect-error native Promises do not support RPC promise pipelining
    observability,
    { requestId: 'request-1' }
  );

  class LifecycleTarget {
    async alarm() {}
  }
  applyTransforms(LifecycleTarget, {
    methods: {
      // @ts-expect-error lifecycle methods cannot be transformed
      alarm: [],
    },
  });
}
void assertRegistrationTypes;

describe('DO transforms', () => {
  it('applies class and method transforms declaratively', async () => {
    const increment = vi.fn();
    const instance = new TestDO({ metrics: { increment } });
    const namespace = withTransforms({
      get: () => ({
        setContext: (context: ObservabilityContext) =>
          instance.setContext(context),
        greet: (name: string) => instance.greet(name),
      }),
    });

    const stub = namespace
      .get()
      .with(observability, { requestId: 'request-1' });

    await expect(stub.greet('Ada')).resolves.toBe('Hello, Ada');
    expect(increment).toHaveBeenNthCalledWith(1, 'do_rpc_calls', {
      requestId: 'request-1',
    });
    expect(increment).toHaveBeenNthCalledWith(2, 'greet_calls', {
      requestId: 'request-1',
    });
    expectTypeOf(stub.greet).parameter(0).toEqualTypeOf<string>();
  });

  it('rejects sending context to a target without setContext', async () => {
    const namespace = withTransforms({
      get: () => ({
        greet: async (name: string) => `Hello, ${name}`,
      }),
    });
    const stub = namespace.get();
    // @ts-expect-error context transforms require a setContext method
    const transformedStub = stub.with(observability, {
      requestId: 'request-1',
    });

    await expect(transformedStub.greet('Ada')).rejects.toThrow(
      'Cannot send transform context to a target without setContext'
    );
  });

  it('leaves synchronous helpers and lifecycle methods untouched', async () => {
    const calls: string[] = [];
    class Service {
      helper(name: string) {
        return name.toUpperCase();
      }

      async greet(name: string) {
        return this.helper(name);
      }

      async alarm() {
        return 'alarm';
      }
    }
    const tracking = defineTransform<Service, Record<never, never>>().callee(
      (_options: void) =>
        async ({ method, next }) => {
          calls.push(method);
          return next();
        }
    );
    applyTransforms(Service, {
      all: [registerTransform(tracking)],
    });

    const service = new Service();
    expect(service.helper('Ada')).toBe('ADA');
    await expect(service.alarm()).resolves.toBe('alarm');
    await expect(service.greet('Ada')).resolves.toBe('ADA');
    expect(calls).toEqual(['greet']);
  });

  it('applies inherited transforms in base-to-derived order', async () => {
    const calls: string[] = [];
    class BaseService {
      async greet() {
        return 'hello';
      }
    }
    const baseTracking = defineTransform<
      BaseService,
      Record<never, never>
    >().callee((_options: void) => async ({ next }) => {
      calls.push('base');
      return next();
    });
    applyTransforms(BaseService, {
      all: [registerTransform(baseTracking)],
    });

    class DerivedService extends BaseService {}
    const derivedTracking = defineTransform<
      DerivedService,
      Record<never, never>
    >().callee((_options: void) => async ({ next }) => {
      calls.push('derived');
      return next();
    });
    applyTransforms(DerivedService, {
      all: [registerTransform(derivedTracking)],
    });

    await expect(new DerivedService().greet()).resolves.toBe('hello');
    expect(calls).toEqual(['base', 'derived']);
  });

  it('supports explicitly registered Promise-returning methods', async () => {
    const calls: string[] = [];
    class PromiseService {
      greet(): Promise<string> {
        return Promise.resolve('hello');
      }
    }
    const tracking = defineTransform<PromiseService>().callee(
      (_options: void) =>
        async ({ next }) => {
          calls.push('greet');
          return next();
        }
    );
    applyTransforms(PromiseService, {
      methods: { greet: [registerTransform(tracking)] },
    });

    await expect(new PromiseService().greet()).resolves.toBe('hello');
    expect(calls).toEqual(['greet']);
  });

  it('does not replace a derived synchronous override with its base method', async () => {
    class BaseService {
      async greet() {
        return 'base';
      }
    }
    class DerivedService extends BaseService {
      override greet(): Promise<string> {
        return Promise.resolve('derived');
      }
    }
    const tracking = defineTransform<DerivedService>().callee(
      (_options: void) =>
        async ({ next }) =>
          next()
    );
    applyTransforms(DerivedService, {
      all: [registerTransform(tracking)],
    });

    await expect(new DerivedService().greet()).resolves.toBe('derived');
  });

  it('rejects malformed context targets', async () => {
    const target = {
      setContext: () => ({}),
      greet: async () => 'hello',
    };
    const stub = createTransformStub(target);
    const unsafeStub = stub.with(
      // @ts-expect-error malformed setContext target is rejected at compile time
      observability,
      { requestId: 'request-1' }
    );

    await expect(unsafeStub.greet()).rejects.toThrow(
      'setContext must return a target with an invoke method'
    );
  });

  it('rejects installing a transform on a side it does not define', () => {
    const callerOnly = defineTransform<TestDO>().caller(
      (_options: { requestId: string }) =>
        async ({ next }) =>
          next()
    );

    expect(() =>
      registerTransform(
        // @ts-expect-error callerOnly has no callee
        callerOnly,
        { requestId: 'request-1' }
      )
    ).toThrow('Transform does not define a callee');
  });
});
