import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  applyTransforms,
  createTransformContextTarget,
  defineTransform,
  registerTransform,
  withTransforms,
} from './index';

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
        env.metrics.increment(options.metricName, {
          requestId: context.requestId,
        });

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
