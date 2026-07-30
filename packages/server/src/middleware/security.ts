import type { MiddlewareHandler } from 'hono';

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

    if (c.req.path.startsWith('/api/') && c.req.header('x-pilcrow') !== '1') {
      return c.json({ error: 'Missing X-Pilcrow header.' }, 403);
    }

    await next();
  };
}
