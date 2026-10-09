import { DEFAULTS } from '../defaults';

export interface Reply {
  status: number;
  headers: Headers;
  setCookie: string[];
  body: string;
  json<T = unknown>(): T;
  location: string | null;
}

let nextVisitor = 1;
/** Each client is its own visitor (its own address), so one client's traffic never trips another's limiter. */
const freshVisitorIp = (): string => {
  const n = nextVisitor++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

/**
 * A cookie-jar HTTP client that talks to `auth.handler` IN PROCESS for the app's own origin, and
 * to the real network (the mock IdP) for any other. Redirects are never followed implicitly: every
 * OAuth/SSO hop is a visible request. It plays the part of the framework mount too: it writes the
 * client address into the one header Better Auth reads (`DEFAULTS.clientIpHeader`), after discarding
 * whatever the caller supplied under that name.
 */
export class TestClient {
  private jar = new Map<string, string>();
  private readonly ip: string;

  constructor(
    private readonly appOrigin: string,
    private readonly handler: (request: Request) => Promise<Response>,
    private readonly defaults: { ip?: string; origin?: string } = {},
  ) {
    this.ip = defaults.ip ?? freshVisitorIp();
  }

  get cookies(): Record<string, string> {
    return Object.fromEntries(this.jar);
  }

  setCookies(cookies: Record<string, string>): void {
    this.jar = new Map(Object.entries(cookies));
  }

  async request(
    method: string,
    path: string,
    init: { json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<Reply> {
    const url = new URL(path, this.appOrigin);
    const sameOrigin = url.origin === this.appOrigin;
    const headers = new Headers(init.headers);
    if (sameOrigin) {
      headers.set('origin', this.defaults.origin ?? this.appOrigin);
      headers.delete(DEFAULTS.clientIpHeader);
      headers.set(DEFAULTS.clientIpHeader, this.ip);
      if (this.jar.size > 0 && !headers.has('cookie')) {
        headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
      }
    }
    let body: string | undefined;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    } else if (init.form) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
      body = new URLSearchParams(init.form).toString();
    }
    const request = new Request(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'manual',
    });
    const res = sameOrigin ? await this.handler(request) : await fetch(request);
    const setCookie = res.headers.getSetCookie();
    if (sameOrigin) {
      for (const line of setCookie) {
        const pair = line.split(';')[0]!;
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (/;\s*max-age=0/i.test(line) || value === '') this.jar.delete(name);
        else this.jar.set(name, value);
      }
    }
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      setCookie,
      body: text,
      json: <T>() => JSON.parse(text) as T,
      location: res.headers.get('location'),
    };
  }

  get(path: string, headers?: Record<string, string>): Promise<Reply> {
    return this.request('GET', path, { headers: headers ?? {} });
  }

  post(path: string, json?: unknown, headers?: Record<string, string>): Promise<Reply> {
    return this.request('POST', path, { json: json ?? {}, headers: headers ?? {} });
  }
}
