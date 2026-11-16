---
'durability': minor
---

Start the retry of a timed-out operation or named alarm on schedule even when its handler has not stopped. A timed-out attempt used to keep its in-memory lock and concurrency permit until the handler settled, so a handler that never settled left the work pending forever, never reaching `maxAttempts`, and held one of the object's permits for good. A timeout now ends the attempt: the permit is returned and the next attempt starts at its retry time. A handler that ignores its abort signal can therefore run beside the retry; its result is discarded, and its `memoize` calls reject once the retry has started.
