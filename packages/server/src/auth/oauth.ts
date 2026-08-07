import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../paths.js';

/**
 * Authorization code + PKCE over a loopback redirect. The primary way to connect.
 *
 * Why this rather than device flow, which is what most local tools reach for: Marky McMarkface already
 * owns a browser tab on the same machine, so it can simply *receive* the redirect. Device flow
 * exists for clients that cannot — TVs, CLIs over SSH. GitHub's own guidance is explicit:
 *
 *   "It is preferable to use the authorization code with PKCE over the device flow, if you are
 *    concerned about using the client secret in a public client. The device flow does not
 *    require redirect URIs at all, which means that an attacker can use the device flow to
 *    remotely impersonate your app as part of a phishing attack."
 *
 * The result is zero codes to read or type: click, approve, you are back and signed in.
 *
 * Note that PKCE does **not** remove the client secret on GitHub — GitHub does not distinguish
 * public from confidential clients, and `client_secret` remains required on the token exchange.
 * PKCE is defence in depth. Shipping the secret in an open-source client is what GitHub's docs
 * tell public clients to do, and what `cli/cli` and `microsoft/vscode` both do in source.
 */

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** `repo` because classic OAuth has no read-only-private scope and we must write reviews.
 *  `read:org` so team-based review requests resolve. Nothing else. */
export const SCOPES = 'repo read:org';

/**
 * Bundled credentials for the Marky McMarkface OAuth App.
 *
 * Register once at:
 *   https://github.com/settings/applications/new
 *     ?oauth_application[name]=Marky McMarkface
 *     &oauth_application[url]=https://github.com/bastiankoerber/marky-mcmarkface
 *     &oauth_application[callback_url]=http://127.0.0.1/callback
 *
 * Register the callback **without a port**. GitHub's loopback rule: "The redirect_uri does not
 * need to match the port specified in the callback URL for the app", so one registration covers
 * whichever port we actually bind. Use 127.0.0.1, never localhost (RFC 8252 §7.3).
 */
// OAuth client IDs identify an application but do not authenticate it. Shipping this value lets
// every installation use GitHub's device flow without asking each user to register another app.
const BUNDLED_CLIENT_ID = 'Ov23liPv4kOFxOGz8Wf0';
const BUNDLED_CLIENT_SECRET = '';

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Where the app's own registration lives, in precedence order:
 *
 *   1. environment — for CI and for anyone running a private fork
 *   2. ~/.marky-mcmarkface/oauth.json — written by the one-time bootstrap screen
 *   3. bundled constants — what ships in the repo once the project is registered
 *
 * (3) is the destination. Once the maintainer registers Marky McMarkface once and commits the values
 * here, nobody ever sees the bootstrap screen again: every user, on every machine, just clicks
 * "Connect GitHub". This is the same thing `cli/cli` and `microsoft/vscode` do, for the same
 * reason — GitHub has no Dynamic Client Registration, so a client id has to come from somewhere,
 * and a public client id is not a secret.
 */
const CONFIG_FILE = join(DATA_DIR, 'oauth.json');

let fileCreds: { clientId: string; clientSecret: string } | null | undefined;

function readFileCreds(): { clientId: string; clientSecret: string } | null {
  if (fileCreds !== undefined) return fileCreds;
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<OAuthCredentials>;
    fileCreds = parsed.clientId ? { clientId: parsed.clientId, clientSecret: parsed.clientSecret ?? '' } : null;
  } catch {
    fileCreds = null;
  }
  return fileCreds;
}

/**
 * The client id, from any source. This is all device flow needs.
 *
 * Shipping only an id — no secret — is what opencode does for GitHub Copilot
 * (`const CLIENT_ID = "Ov23li8tweQw6odWQebz"`) and for its own auth
 * (`const clientId = "opencode-cli"`). A client id is not a credential.
 */
export function appClientId(): string | null {
  return process.env.MARKY_MCMARKFACE_GITHUB_CLIENT_ID || readFileCreds()?.clientId || BUNDLED_CLIENT_ID || null;
}

function appClientSecret(): string | null {
  return process.env.MARKY_MCMARKFACE_GITHUB_CLIENT_SECRET || readFileCreds()?.clientSecret || BUNDLED_CLIENT_SECRET || null;
}

/**
 * Full credentials, required for the authorization-code exchange.
 *
 * The secret is deliberately **optional** across the app. With it, sign-in is one click and no
 * codes. Without it, Marky McMarkface falls back to device flow, which needs no secret — so the repo can
 * ship a working default without committing a secret at all.
 */
export function credentials(): OAuthCredentials | null {
  const clientId = appClientId();
  const clientSecret = appClientSecret();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Save a registration from the bootstrap screen. The secret may be omitted; that simply selects
 * device flow. Takes effect immediately — a restart here would be gratuitous.
 */
export async function saveCredentials(clientId: string, clientSecret: string): Promise<void> {
  const trimmedId = clientId.trim();
  const trimmedSecret = clientSecret.trim();
  if (!trimmedId) throw new Error('A client ID is required.');

  // `mode` on mkdir applies only when the directory is created, so chmod unconditionally —
  // an existing ~/.marky-mcmarkface from an earlier version is world-readable and holds secrets.
  await mkdir(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  await chmod(dirname(CONFIG_FILE), 0o700);
  await writeFile(CONFIG_FILE, JSON.stringify({ clientId: trimmedId, clientSecret: trimmedSecret }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  // `mode` on writeFile only applies when the file is created. An existing file — from an older
  // version, a restored backup, a `cp` — would keep whatever mode it had, holding a secret.
  await chmod(CONFIG_FILE, 0o600);
  fileCreds = { clientId: trimmedId, clientSecret: trimmedSecret };
}

const base64url = (buf: Buffer) => buf.toString('base64url');

/** RFC 7636 code verifier: 43-128 chars from the unreserved set. 32 random bytes gives 43. */
export function createVerifier(): string {
  return base64url(randomBytes(32));
}

/** RFC 7636 S256 challenge. GitHub rejects the `plain` method. */
export function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function createState(): string {
  return base64url(randomBytes(16));
}

/** Constant-time compare so a state check cannot be probed byte by byte. */
export function statesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface PendingFlow {
  state: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

const FLOW_TTL_MS = 10 * 60_000;

/** At most one sign-in at a time; starting a new one abandons the old. */
let pending: PendingFlow | null = null;

export function beginFlow(redirectUri: string): { url: string; flow: PendingFlow } | null {
  const creds = credentials();
  if (!creds) return null;

  const verifier = createVerifier();
  const state = createState();
  const flow: PendingFlow = { state, verifier, redirectUri, createdAt: Date.now() };
  pending = flow;

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), flow };
}

export function takeFlow(state: string): PendingFlow | null {
  const flow = pending;
  if (!flow) return null;
  // Validate *before* consuming. Clearing first let any page abort someone's sign-in simply by
  // causing a request to the callback with a wrong or absent state.
  if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
    pending = null;
    return null;
  }
  if (!statesMatch(flow.state, state)) return null;
  pending = null;
  return flow;
}

export function clearFlow(): void {
  pending = null;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const FRIENDLY: Record<string, string> = {
  bad_verification_code: 'That sign-in link had already been used. Try connecting again.',
  incorrect_client_credentials: 'Marky McMarkface is configured with an invalid OAuth client id or secret.',
  redirect_uri_mismatch:
    'GitHub rejected the redirect address. The OAuth app’s callback URL must be exactly http://127.0.0.1/callback, with no port.',
  access_denied: 'You declined the authorisation on GitHub.',
  application_suspended: 'This OAuth app has been suspended on GitHub.',
};

/**
 * Turn an OAuth error code into a message that is safe to display.
 *
 * Deliberately a lookup with a fixed fallback, never a passthrough: this text can be reached by
 * an unauthenticated GET on the callback, and it lands on the screen that offers to accept a
 * pasted token. An attacker must not be able to choose the words next to that field.
 */
export function describeOAuthError(code: string): string {
  return FRIENDLY[code] ?? 'GitHub could not complete the sign-in. Please try again.';
}

export async function exchangeCode(flow: PendingFlow, code: string): Promise<string> {
  const creds = credentials();
  if (!creds) throw new OAuthError('not_configured', 'Marky McMarkface has no OAuth credentials configured.');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'marky-mcmarkface',
    },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    }),
  });

  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.access_token === 'string') return body.access_token;

  const error = String(body.error ?? 'unknown_error');
  throw new OAuthError(error, FRIENDLY[error] ?? String(body.error_description ?? error));
}

/** The prefilled registration URL, surfaced in the UI when no credentials are configured. */
export function registrationUrl(): string {
  const params = new URLSearchParams({
    'oauth_application[name]': 'Marky McMarkface',
    'oauth_application[url]': 'https://github.com/bastiankoerber/marky-mcmarkface',
    'oauth_application[callback_url]': 'http://127.0.0.1/callback',
  });
  return `https://github.com/settings/applications/new?${params}`;
}
