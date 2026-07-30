import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GitHubClient } from './github/client.js';
import { fetchPr } from './github/pr.js';
import { submitReview, replyToComment, setThreadResolved, type SubmitReviewInput } from './github/review.js';
import { loadToken, saveToken, clearToken, type StoredToken } from './auth/keychain.js';
import { ghStatus, ghToken } from './auth/gh-cli.js';
import { requestDeviceCode, pollForToken, revokeGrant, clientId, DeviceFlowError, type DeviceCode } from './auth/device-flow.js';
import {
  beginFlow,
  takeFlow,
  clearFlow,
  exchangeCode,
  credentials,
  saveCredentials,
  registrationUrl,
  OAuthError,
} from './auth/oauth.js';
import { localOnly } from './middleware/security.js';
import { readPrefs, writePrefs } from './prefs.js';
import { Poller } from './poll.js';

const PORT = Number(process.env.PILCROW_PORT ?? 7423);
const VITE_ORIGIN = process.env.PILCROW_VITE_ORIGIN ?? 'http://localhost:5180';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '../../host/dist');
const hasBuiltUi = existsSync(dist);

/** Where to send the browser back to after GitHub redirects here. In production the server
 *  serves the UI itself, so that is one origin; in development the UI lives on Vite. */
const APP_ORIGIN = () => (hasBuiltUi ? `http://127.0.0.1:${PORT}` : VITE_ORIGIN);

const poller = new Poller();
let client: GitHubClient | null = null;
let stored: StoredToken | null = null;
let deviceInFlight: { device: DeviceCode; abort: AbortController } | null = null;

async function adopt(token: string, source: StoredToken['source']): Promise<StoredToken> {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pilcrow' },
  });
  if (!res.ok) throw new Error(`GitHub rejected this token (${res.status}).`);
  const user = (await res.json()) as { login: string; avatar_url?: string };
  const value: StoredToken = {
    token,
    login: user.login,
    avatarUrl: user.avatar_url ?? '',
    scopes: res.headers.get('x-oauth-scopes') ?? '',
    source,
  };
  await saveToken(value);
  stored = value;
  client = new GitHubClient(token);
  poller.setClient(client);
  return value;
}

async function restore(): Promise<void> {
  stored = await loadToken();
  if (!stored) return;
  client = new GitHubClient(stored.token);
  poller.setClient(client);
}

function requireClient(): GitHubClient {
  if (!client) throw new HttpError(401, 'Not connected to GitHub.');
  return client;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const app = new Hono();
app.use('*', localOnly([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, VITE_ORIGIN]));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  const status = (err as { status?: number }).status;
  return c.json({ error: err.message }, (typeof status === 'number' ? status : 500) as 500);
});

// ── auth ───────────────────────────────────────────────────────────────────────

app.get('/api/auth/status', async (c) =>
  c.json({
    connected: Boolean(stored),
    login: stored?.login ?? null,
    avatarUrl: stored?.avatarUrl ?? null,
    scopes: stored?.scopes ?? null,
    source: stored?.source ?? null,
    oauthConfigured: credentials() !== null,
    deviceFlowConfigured: clientId() !== null,
    registrationUrl: registrationUrl(),
    gh: await ghStatus(),
  }),
);

// ── the primary flow: authorization code + PKCE over a loopback redirect ───────

/**
 * Hand the browser a URL to navigate to. The UI navigates the *current* tab rather than
 * opening a popup: no blocker to trip, no orphaned tab to close afterwards, and returning to
 * the app is the browser's own back-navigation. You leave, you approve, you are back signed in.
 */
/**
 * One-time bootstrap: accept the registration the maintainer just created on GitHub and store
 * it, so the very next click is the ordinary one-click sign-in. No file editing, no restart.
 */
app.post('/api/auth/oauth/configure', async (c) => {
  const { clientId: id, clientSecret } = await c.req.json<{ clientId?: string; clientSecret?: string }>();
  try {
    await saveCredentials(id ?? '', clientSecret ?? '');
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  return c.json({ ok: true });
});

app.post('/api/auth/oauth/start', (c) => {
  const redirectUri = `http://127.0.0.1:${PORT}/gh/callback`;
  const started = beginFlow(redirectUri);
  if (!started) throw new HttpError(400, 'Pilcrow has no OAuth credentials configured.');
  return c.json({ url: started.url });
});

/**
 * GitHub redirects here. Deliberately not under /api, so it needs no `X-Pilcrow` header — a
 * top-level navigation cannot set one. The `Host` check in the security middleware still
 * applies, and `state` is what actually authenticates this callback.
 */
app.get('/gh/callback', async (c) => {
  const back = (params: Record<string, string>) =>
    c.redirect(`${APP_ORIGIN()}/#/connected?${new URLSearchParams(params)}`);

  const error = c.req.query('error');
  if (error) {
    clearFlow();
    return back({ error: c.req.query('error_description') ?? error });
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return back({ error: 'GitHub did not return an authorisation code.' });

  const flow = takeFlow(state);
  if (!flow) {
    return back({ error: 'That sign-in attempt expired or did not match. Please try again.' });
  }

  try {
    const token = await exchangeCode(flow, code);
    const identity = await adopt(token, 'oauth');
    poller.emit('auth', { connected: true, login: identity.login });
    return back({ ok: '1' });
  } catch (err) {
    const message = err instanceof OAuthError ? err.message : (err as Error).message;
    poller.emit('auth-error', { code: 'oauth', message });
    return back({ error: message });
  }
});

/**
 * The token never leaves the server process. It lives in the Keychain and is attached to
 * outbound GitHub calls here; the browser only ever learns who it belongs to. Returning the
 * secret to the UI would put it in memory, in devtools, and in any error reporting the page
 * later grows, for no benefit — the UI has no use for it.
 */
function publicIdentity(value: StoredToken) {
  return { login: value.login, avatarUrl: value.avatarUrl, scopes: value.scopes, source: value.source };
}

app.post('/api/auth/gh', async (c) => c.json(publicIdentity(await adopt(await ghToken(), 'gh-cli'))));

app.post('/api/auth/pat', async (c) => {
  const { token } = await c.req.json<{ token?: string }>();
  if (!token?.trim()) throw new HttpError(400, 'No token supplied.');
  return c.json(publicIdentity(await adopt(token.trim(), 'pat')));
});

app.post('/api/auth/device/start', async (c) => {
  deviceInFlight?.abort.abort();
  const device = await requestDeviceCode();
  const abort = new AbortController();
  deviceInFlight = { device, abort };

  // Poll in the background and announce the result over SSE, so the UI can show the code and
  // simply wait rather than long-polling a request that would outlive most HTTP timeouts.
  void (async () => {
    try {
      const token = await pollForToken(device, abort.signal);
      const value = await adopt(token, 'device-flow');
      poller.emit('auth', { connected: true, login: value.login });
    } catch (err) {
      const code = err instanceof DeviceFlowError ? err.code : 'error';
      if (code !== 'aborted') poller.emit('auth-error', { code, message: (err as Error).message });
    } finally {
      deviceInFlight = null;
    }
  })();

  return c.json({
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    // Prefilled link, so the common path is one click rather than typing the code.
    verificationUriComplete: `${device.verification_uri}?user_code=${encodeURIComponent(device.user_code)}`,
    expiresIn: device.expires_in,
  });
});

app.post('/api/auth/device/cancel', (c) => {
  deviceInFlight?.abort.abort();
  deviceInFlight = null;
  return c.json({ ok: true });
});

app.post('/api/auth/signout', async (c) => {
  if (stored) await revokeGrant(stored.token).catch(() => false);
  await clearToken();
  stored = null;
  client = null;
  poller.setClient(null);
  return c.json({ ok: true });
});

// ── dashboard ──────────────────────────────────────────────────────────────────

app.get('/api/dashboard', async (c) => {
  requireClient();
  const { data, error } = poller.snapshot;
  if (!data) {
    await poller.refresh();
    const retry = poller.snapshot;
    if (!retry.data) throw new HttpError(502, retry.error ?? 'Could not load the dashboard.');
    return c.json({ ...retry.data, prefs: await readPrefs() });
  }
  return c.json({ ...data, staleError: error, prefs: await readPrefs() });
});

app.post('/api/dashboard/refresh', async (c) => {
  requireClient();
  await poller.refresh();
  const { data, error } = poller.snapshot;
  if (!data) throw new HttpError(502, error ?? 'Refresh failed.');
  return c.json(data);
});

app.post('/api/focus', async (c) => {
  const { focused } = await c.req.json<{ focused: boolean }>();
  poller.setFocus(Boolean(focused));
  return c.json({ ok: true });
});

// ── prefs ──────────────────────────────────────────────────────────────────────

app.get('/api/prefs', async (c) => c.json(await readPrefs()));
app.post('/api/prefs', async (c) => c.json(await writePrefs(await c.req.json())));

// ── pull requests ──────────────────────────────────────────────────────────────

app.get('/api/pr/:owner/:repo/:number', async (c) => {
  const { owner, repo } = c.req.param();
  const number = Number(c.req.param('number'));
  if (!Number.isInteger(number)) throw new HttpError(400, 'Bad pull request number.');
  return c.json(await fetchPr(requireClient(), owner, repo, number));
});

app.post('/api/pr/:owner/:repo/:number/review', async (c) => {
  const { owner, repo } = c.req.param();
  const number = Number(c.req.param('number'));
  const input = await c.req.json<SubmitReviewInput>();
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(input.event)) {
    throw new HttpError(400, 'Unknown review event.');
  }
  if (input.event === 'COMMENT' && !input.body.trim() && input.comments.length === 0) {
    throw new HttpError(400, 'A comment review needs either a summary or at least one comment.');
  }
  const result = await submitReview(requireClient(), owner, repo, number, input);
  void poller.refresh();
  return c.json(result);
});

app.post('/api/pr/:owner/:repo/:number/reply', async (c) => {
  const { owner, repo } = c.req.param();
  const number = Number(c.req.param('number'));
  const { commentId, body } = await c.req.json<{ commentId: number; body: string }>();
  if (!commentId || !body?.trim()) throw new HttpError(400, 'Reply needs a comment id and a body.');
  return c.json(await replyToComment(requireClient(), owner, repo, number, commentId, body));
});

app.post('/api/thread/resolve', async (c) => {
  const { threadId, resolved } = await c.req.json<{ threadId: string; resolved: boolean }>();
  if (!threadId) throw new HttpError(400, 'Missing thread id.');
  return c.json({ resolved: await setThreadResolved(requireClient(), threadId, Boolean(resolved)) });
});

// ── events ─────────────────────────────────────────────────────────────────────

app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    let alive = true;
    const unsubscribe = poller.subscribe((event, data) => {
      if (!alive) return;
      void stream.writeSSE({ event, data: JSON.stringify(data) });
    });
    stream.onAbort(() => {
      alive = false;
      unsubscribe();
    });
    // Hold the connection open; heartbeats keep proxies and the browser from closing it.
    while (alive) {
      await stream.sleep(25_000);
      if (alive) await stream.writeSSE({ event: 'ping', data: '{}' });
    }
  }),
);

// ── static (production build) ──────────────────────────────────────────────────

if (hasBuiltUi) {
  app.use('/*', serveStatic({ root: dist }));
  app.get('*', serveStatic({ path: join(dist, 'index.html') }));
}

await restore();

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`\n  pilcrow server  http://127.0.0.1:${info.port}`);
  console.log(`  bound to 127.0.0.1 only${existsSync(dist) ? '' : '  (dev: run the Vite server for the UI)'}`);
  if (!clientId()) {
    console.log(`  device flow disabled — set PILCROW_GITHUB_CLIENT_ID to enable it; "Use GitHub CLI" works now`);
  }
  console.log('');
});

export { app };
