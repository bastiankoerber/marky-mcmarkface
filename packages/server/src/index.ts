// Must stay first: ESM evaluates imports in order, and this one populates process.env from
// `.env` before anything below reads it.
import './env.js';

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { GitHubClient } from './github/client.js';
import { fetchPr } from './github/pr.js';
import {
  submitReview,
  replyToComment,
  setThreadResolved,
  ReviewSubmitError,
  type SubmitReviewInput,
} from './github/review.js';
import {
  loadToken,
  saveToken,
  clearToken,
  hasStoredToken,
  unlockToken,
  type StoredToken,
} from './auth/keychain.js';
import { ghStatus, ghToken } from './auth/gh-cli.js';
import { TokenValidationError, tokenRejection } from './auth/token-validation.js';
import { requestDeviceCode, pollForToken, revokeGrant, clientId, DeviceFlowError, type DeviceCode } from './auth/device-flow.js';
import {
  beginFlow,
  takeFlow,
  clearFlow,
  exchangeCode,
  credentials,
  saveCredentials,
  registrationUrl,
  describeOAuthError,
  OAuthError,
} from './auth/oauth.js';
import { localOnly, sessionKey, publishSessionKey } from './middleware/security.js';
import { readPrefs, writePrefs } from './prefs.js';
import { Poller } from './poll.js';

const PORT = Number(process.env.MARKY_MCMARKFACE_PORT ?? 7423);
const VITE_ORIGIN = process.env.MARKY_MCMARKFACE_VITE_ORIGIN ?? 'http://localhost:5180';
const DESKTOP = process.env.MARKY_MCMARKFACE_DESKTOP === '1';

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.env.MARKY_MCMARKFACE_UI_DIST
  ? resolve(process.env.MARKY_MCMARKFACE_UI_DIST)
  : join(here, '../../host/dist');
const hasBuiltUi = existsSync(dist);

/** Where to send the browser back to after GitHub redirects here. In production the server
 *  serves the UI itself, so that is one origin; in development the UI lives on Vite. */
const APP_ORIGIN = () => (hasBuiltUi ? `http://127.0.0.1:${PORT}` : VITE_ORIGIN);

const poller = new Poller();
let client: GitHubClient | null = null;
let stored: StoredToken | null = null;
let pending: { value: StoredToken; expiresAt: number } | null = null;
let storageMode: 'keychain' | 'session' | null = null;
let locked = false;
let deviceInFlight: { device: DeviceCode; abort: AbortController } | null = null;

async function identifyToken(token: string, source: StoredToken['source']): Promise<StoredToken> {
  let res: Response;
  try {
    res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'marky-mcmarkface' },
    });
  } catch {
    throw new TokenValidationError(
      502,
      'Could not reach GitHub to validate the token. Check your internet connection, VPN, proxy, or firewall.',
    );
  }
  if (!res.ok) throw tokenRejection(res.status, res.headers);

  let user: { login?: unknown; avatar_url?: unknown };
  try {
    user = (await res.json()) as { login?: unknown; avatar_url?: unknown };
  } catch {
    throw new TokenValidationError(502, 'GitHub returned an unexpected response while validating the token.');
  }
  if (typeof user.login !== 'string' || !user.login) {
    throw new TokenValidationError(502, 'GitHub returned an incomplete account response while validating the token.');
  }
  const value: StoredToken = {
    token,
    login: user.login,
    avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : '',
    scopes: res.headers.get('x-oauth-scopes') ?? '',
    source,
  };
  return value;
}

function activate(value: StoredToken, mode: 'keychain' | 'session'): void {
  stored = value;
  pending = null;
  locked = false;
  storageMode = mode;
  client = new GitHubClient(value.token);
  poller.setClient(client);
}

/**
 * Validate a token, but do not touch Keychain in the desktop app. The renderer first shows the
 * account and an explanation of the macOS prompt, then explicitly commits or discards this
 * short-lived in-memory value.
 */
async function adopt(token: string, source: StoredToken['source']): Promise<StoredToken> {
  const value = await identifyToken(token, source);
  if (DESKTOP) {
    pending = { value, expiresAt: Date.now() + 10 * 60_000 };
    return value;
  }
  await saveToken(value);
  activate(value, 'keychain');
  return value;
}

function pendingValue(): StoredToken | null {
  if (pending && pending.expiresAt <= Date.now()) pending = null;
  return pending?.value ?? null;
}

async function restore(): Promise<void> {
  if (DESKTOP) {
    // Looking for the encrypted file does not touch Keychain. Decryption is a later, explicit
    // user action, after the window has explained the macOS dialog.
    locked = await hasStoredToken();
    return;
  }
  stored = await loadToken();
  if (!stored) return;
  activate(stored, 'keychain');
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

/**
 * Read a JSON body without ever echoing it back.
 *
 * `JSON.parse` embeds the first ~10 characters of its input in the SyntaxError message, and the
 * error handler used to relay `err.message` verbatim — so a malformed POST to `/api/auth/pat`
 * replied with `Unexpected token 'g', "github_pat"... is not valid JSON`, handing back a slice
 * of the credential that was just pasted.
 */
async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'Malformed request body.');
  }
}

app.onError((err, c) => {
  // Only messages we authored are relayed. Anything else could carry request or upstream
  // content — including a credential — so it is logged shape-only and replaced.
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof TokenValidationError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof ReviewSubmitError || err instanceof OAuthError || err instanceof DeviceFlowError) {
    return c.json({ error: err.message }, 400);
  }
  console.error(`[marky-mcmarkface] ${c.req.method} ${c.req.path} failed: ${(err as Error).name}`);
  return c.json({ error: 'Something went wrong handling that request.' }, 500);
});

// ── auth ───────────────────────────────────────────────────────────────────────

app.get('/api/auth/status', async (c) => {
  const waiting = pendingValue();
  return c.json({
    connected: Boolean(stored),
    login: stored?.login ?? null,
    avatarUrl: stored?.avatarUrl ?? null,
    scopes: stored?.scopes ?? null,
    source: stored?.source ?? null,
    storage: locked ? 'locked' : storageMode ?? 'none',
    pending: waiting ? publicIdentity(waiting) : null,
    oauthConfigured: credentials() !== null,
    deviceFlowConfigured: clientId() !== null,
    registrationUrl: registrationUrl(),
    desktop: DESKTOP,
    gh: await ghStatus(),
  });
});

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
  const { clientId: id, clientSecret } = await readJson<{ clientId?: string; clientSecret?: string }>(c);
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
  if (!started) throw new HttpError(400, 'Marky McMarkface has no OAuth credentials configured.');
  return c.json({ url: started.url });
});

/**
 * GitHub redirects here. Deliberately not under /api, so it needs no `X-Marky-McMarkface` header — a
 * top-level navigation cannot set one. The `Host` check in the security middleware still
 * applies, and `state` is what actually authenticates this callback.
 */
app.get('/gh/callback', async (c) => {
  const back = (params: Record<string, string>) => {
    if (!DESKTOP) {
      return c.redirect(`${APP_ORIGIN()}/#/connected?${new URLSearchParams(params)}`);
    }

    const ok = params.ok === '1';
    const message = ok
      ? DESKTOP
        ? 'GitHub approved the connection. Return to Marky McMarkface to choose how to protect it.'
        : 'GitHub is connected. You can close this window and return to Marky McMarkface.'
      : params.error || 'GitHub sign-in did not complete.';
    const safe = message
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Marky McMarkface</title></head><body><main><h1>${ok ? 'Connected' : 'Sign-in failed'}</h1><p>${safe}</p></main></body></html>`,
    );
  };

  /*
   * Never put a caller-supplied string on the sign-in screen.
   *
   * This endpoint takes no authentication — it cannot, because it is a top-level navigation
   * back from GitHub. So anything reflected from the query string is attacker-controlled text
   * rendered by the real app, at the real localhost origin, on the one screen that has a
   * paste-your-token box on it. That is a credential-phishing primitive, and it was live:
   * `?error_description=Your+session+expired.+Paste+a+personal+access+token+to+reconnect.`
   * came straight back out.
   *
   * GitHub's `error` codes are a known, closed set, so map them and drop the rest.
   */
  const error = c.req.query('error');
  if (error) {
    const message = describeOAuthError(error);
    if (DESKTOP) poller.emit('auth-error', { code: error, message });
    return back({ error: message });
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) {
    const message = 'GitHub did not return an authorisation code.';
    if (DESKTOP) poller.emit('auth-error', { code: 'missing_code', message });
    return back({ error: message });
  }

  // Only consume the pending flow once the state matches. Clearing it first meant any page
  // could kill an in-flight sign-in with <img src=".../gh/callback?error=x">.
  const flow = takeFlow(state);
  if (!flow) {
    const message = 'That sign-in attempt expired or did not match. Please try again.';
    if (DESKTOP) poller.emit('auth-error', { code: 'state_mismatch', message });
    return back({ error: message });
  }

  try {
    const token = await exchangeCode(flow, code);
    const identity = await adopt(token, 'oauth');
    poller.emit(DESKTOP ? 'auth-pending' : 'auth', {
      connected: !DESKTOP,
      login: identity.login,
    });
    return back({ ok: '1' });
  } catch (err) {
    const message = err instanceof OAuthError ? err.message : (err as Error).message;
    poller.emit('auth-error', { code: 'oauth', message });
    return back({ error: message });
  }
});

/**
 * The token never leaves the server process. It is encrypted with a Keychain-protected key or
 * kept in memory for this session, and is attached to outbound GitHub calls here; the browser
 * only ever learns who it belongs to. Returning the secret to the UI would put it in renderer
 * memory, devtools, and any error reporting the page later grows, for no benefit.
 */
function publicIdentity(value: StoredToken) {
  return { login: value.login, avatarUrl: value.avatarUrl, scopes: value.scopes, source: value.source };
}

app.post('/api/auth/storage/commit', async (c) => {
  if (!DESKTOP) throw new HttpError(400, 'Storage choices are managed automatically in this installation.');
  const value = pendingValue();
  if (!value) throw new HttpError(409, 'That GitHub connection expired. Please connect again.');
  const { mode } = await readJson<{ mode?: string }>(c);
  if (mode !== 'keychain' && mode !== 'session') throw new HttpError(400, 'Choose a storage method.');

  if (mode === 'keychain') {
    try {
      await saveToken(value);
    } catch {
      // Do not expose a native error: it may contain OS details and it cannot reliably
      // distinguish Deny from a locked or unavailable Keychain.
      throw new HttpError(
        400,
        'macOS did not save the connection. Nothing was stored; you can try again or use it until you quit.',
      );
    }
  }

  activate(value, mode);
  poller.emit('auth', { connected: true, login: value.login });
  return c.json(publicIdentity(value));
});

app.post('/api/auth/storage/cancel', async (c) => {
  const value = pendingValue();
  pending = null;
  if (value && (value.source === 'oauth' || value.source === 'device-flow')) {
    await revokeGrant(value.token).catch(() => false);
  }
  return c.json({ ok: true });
});

app.post('/api/auth/storage/unlock', async (c) => {
  if (!DESKTOP || !locked) throw new HttpError(404, 'No saved GitHub connection was found.');
  let value: StoredToken;
  try {
    value = await unlockToken();
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  activate(value, 'keychain');
  poller.emit('auth', { connected: true, login: value.login });
  return c.json(publicIdentity(value));
});

app.post('/api/auth/storage/forget', async (c) => {
  await clearToken();
  locked = false;
  return c.json({ ok: true });
});

app.post('/api/auth/gh', async (c) => c.json(publicIdentity(await adopt(await ghToken(), 'gh-cli'))));

app.post('/api/auth/pat', async (c) => {
  const { token } = await readJson<{ token?: string }>(c);
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
      poller.emit(DESKTOP ? 'auth-pending' : 'auth', {
        connected: !DESKTOP,
        login: value.login,
      });
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
  pending = null;
  locked = false;
  storageMode = null;
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
  const { focused } = await readJson<{ focused: boolean }>(c);
  poller.setFocus(Boolean(focused));
  return c.json({ ok: true });
});

// ── prefs ──────────────────────────────────────────────────────────────────────

app.get('/api/prefs', async (c) => c.json(await readPrefs()));
app.post('/api/prefs', async (c) => c.json(await writePrefs(await readJson<Record<string, unknown>>(c))));

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
  const input = await readJson<SubmitReviewInput>(c);
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(input.event)) {
    throw new HttpError(400, 'Unknown review event.');
  }
  if (input.event === 'COMMENT' && !input.body.trim() && input.comments.length === 0) {
    throw new HttpError(400, 'A comment review needs either a summary or at least one comment.');
  }
  // File-level comments need the head SHA; fill it in here rather than trusting the client.
  if (!input.commitId && input.comments.some((c) => c.subjectType === 'file')) {
    const pr = await requireClient().rest<{ head: { sha: string } }>(`/repos/${owner}/${repo}/pulls/${number}`);
    input.commitId = pr.head.sha;
  }
  const result = await submitReview(requireClient(), owner, repo, number, input);
  void poller.refresh();
  return c.json(result);
});

app.post('/api/pr/:owner/:repo/:number/reply', async (c) => {
  const { owner, repo } = c.req.param();
  const number = Number(c.req.param('number'));
  const { commentId, body } = await readJson<{ commentId: number; body: string }>(c);
  if (!commentId || !body?.trim()) throw new HttpError(400, 'Reply needs a comment id and a body.');
  return c.json(await replyToComment(requireClient(), owner, repo, number, commentId, body));
});

app.post('/api/thread/resolve', async (c) => {
  const { threadId, resolved } = await readJson<{ threadId: string; resolved: boolean }>(c);
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
  // Hand the UI this launch's key by injecting it into the document it is served from. That
  // keeps the key out of any endpoint an unauthenticated caller could ask for it from.
  const indexHtml = join(dist, 'index.html');
  const serveIndex = async () => {
    const html = await readFile(indexHtml, 'utf8');
    return new Response(
      html.replace('</head>', `<meta name="marky-mcmarkface-key" content="${sessionKey()}"></head>`),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  };
  app.get('/', () => serveIndex());
  app.use('/assets/*', serveStatic({ root: dist }));
  app.use('/*', serveStatic({ root: dist }));
  app.get('*', () => serveIndex());
}

publishSessionKey();
await restore();

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`\n  marky-mcmarkface server  http://127.0.0.1:${info.port}`);
  console.log(`  bound to 127.0.0.1 only${existsSync(dist) ? '' : '  (dev: run the Vite server for the UI)'}`);
  if (!clientId()) {
    console.log(`  device flow disabled — set MARKY_MCMARKFACE_GITHUB_CLIENT_ID to enable it; "Use GitHub CLI" works now`);
  }
  console.log('');
});

export { app };
