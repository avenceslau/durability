export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Calls the admin API and returns the parsed JSON body, or `null` for an empty one. */
export const api = async (
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> => {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  const response = await fetch(path, init);
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // A proxy or the runtime can answer with plain text or HTML.
    parsed = { error: text.slice(0, 200) };
  }
  if (response.ok) {
    return parsed;
  }

  const message =
    typeof parsed === 'object' &&
    parsed !== null &&
    'error' in parsed &&
    typeof parsed.error === 'string'
      ? parsed.error
      : `Request failed with status ${response.status}`;
  throw new ApiError(response.status, message, parsed);
};

export const queuePath = (queue: string): string =>
  `/api/queues/${encodeURIComponent(queue)}`;
