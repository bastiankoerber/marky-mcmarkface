import type { MiddlewareHandler } from 'hono';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { browserSecurityHeaders } from '../security-policy.js';
import { DATA_DIR } from '../paths.js';

/**
 * A per-launch key, replacing the fixed `X-Marky-McMarkface: 1`.
 *
 * The constant was correct CSRF defence — a browser cannot set a custom header cross-origin
 * without a preflight we reject — but it was not a capability. Any local process could read
 * every private pull request and post approvals with a one-line `curl`, because the value was
 * published in the source and in SECURITY.md.
 *
 * Be honest about what this does and does not buy: the browser must receive the key in production,
 * and the development proxy supplies it automatically. A local process that can reach Marky McMarkface's
 * loopback ports can therefore imitate the browser. The key is a browser CSRF control, not an OS
 * user boundary and not a defence against code already running on the machine.
 */
const SESSION_KEY = randomBytes(24).toString('base64url');
const KEY_FILE = join(DATA_DIR, 'session');

export function sessionKey(): string {
  return SESSION_KEY;
}

/** Written so the Vite dev proxy can attach the header in development. */
export function publishSessionKey(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    chmodSync(DATA_DIR, 0o700);
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
 *   X-Marky-McMarkface  — a header a <form> cannot set, and which forces a preflight on cross-origin fetch
 *             that we then fail. This is what actually stops CSRF, since Origin is absent on
 *             some same-origin requests and cannot be relied on alone.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

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
      return c.json({ error: 'marky-mcmarkface only accepts requests addressed to localhost.' }, 403);
    }

    const origin = c.req.header('origin');
    if (origin && !allowed.has(origin)) {
      return c.json({ error: `Origin ${origin} is not allowed.` }, 403);
    }

    if (c.req.path.startsWith('/api/') && !isAuthorised(c.req.header('x-marky-mcmarkface'))) {
      return c.json({ error: 'Missing or invalid X-Marky-McMarkface header.' }, 403);
    }

    await next();

    for (const [name, value] of Object.entries(browserSecurityHeaders())) c.header(name, value);
  };
}
