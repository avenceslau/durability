---
title: Retries and timeouts
description: Retries and timeouts for durable capabilities.
---

## Retries, timeouts, and terminal failures

Attempts use exponential backoff with equal jitter, stop after five attempts, and time out after five minutes by default. The retry `delay` function fully controls scheduling and can be overridden globally or per method on either helper:

```ts
import { exponential, jitter } from 'durability/utils';

const durability = new Durability({
  context: this.ctx,
  handlers,
  attemptTimeoutMs: 60_000,
  retries: {
    maxAttempts: 5,
    delay: (attempt) => jitter(exponential(attempt)),
  },
  methods: {
    resizeImage: {
      attemptTimeoutMs: 10 * 60_000,
      retries: {
        maxAttempts: 2,
        delay: (attempt) => exponential(attempt, 500, 30_000),
      },
    },
  },
});
```

Each attempt receives its own `AbortSignal`. A timed-out operation follows the normal retry policy; a timed-out named alarm is terminal unless `retryTimeouts` is set. If a handler ignores abort, its in-memory lock and concurrency permit remain held until it actually settles, so a same-isolate retry cannot overlap it.

Throw `NonRetryableError` to move work directly to `failed` without another attempt. Errors named `NonRetryableError` from other packages, such as `cloudflare:workflows`, are recognized too.
