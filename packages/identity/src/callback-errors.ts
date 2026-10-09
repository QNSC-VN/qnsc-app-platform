import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Better Auth's OAuth callback has one generic failure for "the provider's answer is not acceptable"
 * (`error=unable_to_get_user_info`) and no way for a custom `getUserInfo` to say WHY. This carries a
 * specific code from `getUserInfo` to the response of the same request, so the browser lands on
 * `?error=ACCOUNT_LINK_REQUIRED` and the product can tell the user what to do.
 */
const store = new AsyncLocalStorage<{ code?: string }>();

/** Called from inside a provider's `getUserInfo`: refuse this sign-in with `code`. */
export function refuseCallbackWith(code: string): void {
  const slot = store.getStore();
  if (slot) slot.code = code;
}

export function withCallbackErrorCodes(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) =>
    store.run({}, async () => {
      const response = await handler(request);
      const code = store.getStore()?.code;
      const location = response.headers.get('location');
      if (!code || !location || response.status < 300 || response.status > 399) return response;
      const url = new URL(location, request.url);
      if (!url.searchParams.has('error')) return response;
      url.searchParams.set('error', code);
      const headers = new Headers(response.headers);
      headers.set(
        'location',
        location.startsWith('/') ? `${url.pathname}${url.search}` : url.toString(),
      );
      return new Response(null, { status: response.status, headers });
    });
}
