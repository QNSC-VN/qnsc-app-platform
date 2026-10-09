/**
 * A tiny cookie-jar HTTP client. Redirects are NEVER followed implicitly: every OAuth/SSO step
 * is a visible request in the test. Cookies are replayed regardless of `Secure` (the spike
 * serves plain HTTP on 127.0.0.1 while the app is configured `useSecureCookies: true`).
 */
export interface Reply {
  status: number;
  headers: Headers;
  setCookie: string[];
  body: string;
  json<T = unknown>(): T;
  location: string | null;
}

let nextAddress = 1;

/**
 * Each client behaves like its own visitor behind Cloudflare: a distinct `cf-connecting-ip`
 * unless the test sets one. Without it every client would share 127.0.0.1 and Better Auth's
 * (correct) per-IP limiter, 3 sign-ins / 10 s, would throttle the suite itself.
 */
function freshVisitorIp(): string {
  const n = nextAddress++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

export class Client {
  private jar = new Map<string, string>();
  private readonly defaults: Record<string, string>;

  constructor(
    readonly base: string,
    defaults: Record<string, string> = {},
  ) {
    this.defaults = { 'cf-connecting-ip': freshVisitorIp(), ...defaults };
  }

  get cookies(): Record<string, string> {
    return Object.fromEntries(this.jar);
  }

  /** Replace the jar (used to replay a captured cookie from another client). */
  setCookies(cookies: Record<string, string>): void {
    this.jar = new Map(Object.entries(cookies));
  }

  get cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(
    method: string,
    path: string,
    init: { json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<Reply> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    // Cookies belong to the app's origin only: never replay them to an IdP.
    const sameOrigin = new URL(url).origin === new URL(this.base).origin;
    const headers: Record<string, string> = sameOrigin
      ? { origin: this.defaults['origin'] ?? this.base, ...this.defaults, ...init.headers }
      : { ...init.headers };
    if (sameOrigin && this.jar.size > 0 && !('cookie' in headers))
      headers['cookie'] = this.cookieHeader;
    let body: string | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    }
    const res = await fetch(url, { method, headers, body, redirect: 'manual' });
    const setCookie = res.headers.getSetCookie();
    for (const line of sameOrigin ? setCookie : []) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (/;\s*max-age=0/i.test(line) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
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
