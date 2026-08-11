const API = 'https://api.github.com';
const UA = 'marky-mcmarkface/0.1';

/**
 * Thin GitHub client over fetch.
 *
 * Deliberately not Octokit: the two behaviours this app depends on — conditional requests that
 * cost zero rate limit, and reading `X-RateLimit-*` off the actual response rather than trusting
 * `GET /rate_limit` (which reports stale search numbers) — both want raw header access.
 */

export interface RateSnapshot {
  resource: string;
  limit: number;
  remaining: number;
  reset: number;
}

export interface GitHubBinary {
  body: ArrayBuffer;
  contentType: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

function requiresSso(res: Response): boolean {
  return res.headers.get('x-github-sso')?.toLowerCase().includes('required') ?? false;
}

function isRateLimited(res: Response): boolean {
  return (
    res.status === 429 ||
    res.headers.has('retry-after') ||
    (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
  );
}

/** Fixed, user-safe explanations: never relay a possibly credential-bearing upstream body. */
export function githubRejectionMessage(res: Response): string {
  if (res.status === 401) return 'GitHub rejected the saved token. It may be expired or revoked; reconnect GitHub.';
  if (res.status === 403 && requiresSso(res)) {
    return 'GitHub requires SAML SSO authorization for this token or OAuth app. Authorize it for your organisation, then reconnect.';
  }
  if (isRateLimited(res)) return 'GitHub rate limit reached.';
  if (res.status === 403) {
    return 'GitHub denied access. Your organisation may require app or token approval, SAML SSO authorization, or additional repository permissions.';
  }
  return `GitHub request failed (${res.status}).`;
}

function githubResponseError(res: Response, body?: unknown): GitHubError {
  return new GitHubError(res.status, githubRejectionMessage(res), body);
}

export function githubGraphqlErrorMessage(errors: Array<{ message: string; type?: string }>): string {
  const denied = errors.some(
    (error) =>
      error.type?.toUpperCase() === 'FORBIDDEN' ||
      /resource not accessible|not authorized|saml|single sign-on|sso/i.test(error.message),
  );
  return denied
    ? 'GitHub denied access to pull-request data. Your organisation may require app or token approval, SAML SSO authorization, or additional repository permissions.'
    : 'GitHub could not load pull-request data.';
}

interface CacheEntry {
  etag: string;
  data: unknown;
}

export class GitHubClient {
  #token: string;
  readonly #etags = new Map<string, CacheEntry>();
  #rate: RateSnapshot | null = null;
  /** Set when GitHub returns 403/429 with a reset time; all callers back off until then. */
  #blockedUntil = 0;

  constructor(token: string) {
    this.#token = token;
  }

  setToken(token: string): void {
    this.#token = token;
    this.#etags.clear();
  }

  get rate(): RateSnapshot | null {
    return this.#rate;
  }

  get blockedUntil(): number {
    return this.#blockedUntil;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.#token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...extra,
    };
  }

  #readRate(res: Response): void {
    const limit = Number(res.headers.get('x-ratelimit-limit'));
    if (!Number.isFinite(limit)) return;
    this.#rate = {
      resource: res.headers.get('x-ratelimit-resource') ?? 'core',
      limit,
      remaining: Number(res.headers.get('x-ratelimit-remaining') ?? 0),
      reset: Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000,
    };
  }

  #noteBlocked(res: Response): void {
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      this.#blockedUntil = Date.now() + retryAfter * 1000;
      return;
    }
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) this.#blockedUntil = reset * 1000;
  }

  /**
   * REST GET with conditional-request support. A 304 costs zero rate limit, so anything polled
   * on a timer should pass `cache: true`. Only worth it on stable resources — volatile listings
   * change between polls and never return 304.
   */
  async rest<T>(path: string, opts: { cache?: boolean; accept?: string } = {}): Promise<T> {
    // Always relative to api.github.com. Accepting an absolute URL here would mean a future
    // caller that forwards a URL out of a GitHub response body ships the repo-scoped token to
    // whatever host that URL names.
    const url = `${API}${path}`;
    const cached = opts.cache ? this.#etags.get(url) : undefined;
    const headers = this.#headers(opts.accept ? { Accept: opts.accept } : {});
    if (cached) headers['If-None-Match'] = cached.etag;

    const res = await fetch(url, { headers });
    this.#readRate(res);

    if (res.status === 304 && cached) return cached.data as T;
    if (!res.ok) {
      if (isRateLimited(res)) this.#noteBlocked(res);
      throw githubResponseError(res, await safeBody(res));
    }

    const data = opts.accept === 'application/vnd.github.raw' ? ((await res.text()) as unknown as T) : ((await res.json()) as T);
    const etag = res.headers.get('etag');
    if (opts.cache && etag) this.#etags.set(url, { etag, data });
    return data;
  }

  async restRaw(path: string): Promise<string> {
    return this.rest<string>(path, { accept: 'application/vnd.github.raw' });
  }

  /** Binary REST GET for repository assets. The token is still sent only to api.github.com. */
  async restBytes(path: string, maxBytes: number): Promise<GitHubBinary> {
    const res = await fetch(`${API}${path}`, {
      headers: this.#headers({ Accept: 'application/vnd.github.raw' }),
    });
    this.#readRate(res);
    if (!res.ok) {
      if (isRateLimited(res)) this.#noteBlocked(res);
      throw githubResponseError(res, await safeBody(res));
    }

    const reported = Number(res.headers.get('content-length'));
    if (Number.isFinite(reported) && reported > maxBytes) {
      throw new GitHubError(413, 'Repository image is larger than the supported limit.');
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new GitHubError(413, 'Repository image is larger than the supported limit.');
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = bytes.buffer;
    return { body, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  async write<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: this.#headers({ 'Content-Type': 'application/json' }) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, init);
    this.#readRate(res);
    if (!res.ok) {
      if (isRateLimited(res)) this.#noteBlocked(res);
      throw githubResponseError(res, await safeBody(res));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * GraphQL. The dashboard lives here rather than in REST search because GraphQL `search` does
   * not consume the REST search bucket (30/min) — four search connections in one query measure
   * cost 1 against 5000/hr.
   */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: this.#headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query, variables }),
    });
    this.#readRate(res);
    if (!res.ok) {
      if (isRateLimited(res)) this.#noteBlocked(res);
      throw githubResponseError(res);
    }
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string; type?: string }> };
    if (body.errors?.length) {
      throw new GitHubError(res.status, githubGraphqlErrorMessage(body.errors), body.errors);
    }
    if (!body.data) throw new GitHubError(res.status, 'GraphQL returned no data');
    return body.data;
  }

  /** Raw response, for callers that need headers (notifications' X-Poll-Interval). */
  async restWithHeaders<T>(path: string): Promise<{ data: T | null; headers: Headers; status: number }> {
    const url = `${API}${path}`;
    const cached = this.#etags.get(url);
    const headers = this.#headers();
    if (cached) headers['If-None-Match'] = cached.etag;

    const res = await fetch(url, { headers });
    this.#readRate(res);
    if (res.status === 304 && cached) return { data: cached.data as T, headers: res.headers, status: 304 };
    if (!res.ok) {
      if (isRateLimited(res)) this.#noteBlocked(res);
      throw githubResponseError(res);
    }

    const data = (await res.json()) as T;
    const etag = res.headers.get('etag');
    if (etag) this.#etags.set(url, { etag, data });
    return { data, headers: res.headers, status: res.status };
  }
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
