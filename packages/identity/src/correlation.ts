/**
 * The correlation id of the request an auth email belongs to (platform contract §7), so one id
 * follows the action from the API request into the `mail.send` worker's log lines.
 *
 * It comes from `observability`'s request context, the store `platform-http`'s `enableCorrelationId`
 * seeds. `observability` is an OPTIONAL peer of this package: without it, or outside a request, there
 * is no id and the message simply has none.
 */

/** Contract §7: 1 to 128 characters from `[A-Za-z0-9._:-]`. */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The value if it is a valid correlation id, else `undefined`. Never echoes what it rejected: the id
 * is untrusted input on every path (it ends up in log lines and job payloads).
 */
export function validCorrelationId(value: unknown): string | undefined {
  return typeof value === 'string' && CORRELATION_ID.test(value) ? value : undefined;
}

type Store = { getStore(): { correlationId?: unknown } | undefined };
let store: Store | null | undefined;

function requestContextStore(): Store | null {
  if (store !== undefined) return store;
  try {
    // Loaded lazily and optionally: the core must not require a Nest-based package at import time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    store = (require('@quynhonsemiconductor/observability') as { requestContextStorage: Store })
      .requestContextStorage;
  } catch {
    store = null;
  }
  return store;
}

/** The current request's (or job's) correlation id, if there is one and it is valid. */
export function requestCorrelationId(): string | undefined {
  return validCorrelationId(requestContextStore()?.getStore()?.correlationId);
}
