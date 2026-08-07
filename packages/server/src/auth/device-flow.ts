/**
 * GitHub OAuth device flow.
 *
 * Two verified behaviours drive the shape of this code, and both silently break naive
 * implementations:
 *
 *   1. Error responses come back as **HTTP 200** with an `error` field in the JSON body. Any
 *      client that branches on status code treats `authorization_pending` as success.
 *   2. `slow_down` carries a **new `interval` in the body**, and it is cumulative (observed 10,
 *      then 15). Adopting `body.interval` is required; `interval + 5` drifts out of step.
 */

import { appClientId, credentials } from './oauth.js';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** Scopes: `repo` because classic OAuth has no read-only-private option and we must write
 *  reviews; `read:org` so team-based review requests resolve. Nothing else. */
export const SCOPES = 'repo read:org';

/**
 * Device flow needs the client id and **nothing else** — no client secret, ever. That is what
 * lets the repo ship a working default without committing a credential.
 */
export function clientId(): string | null {
  return appClientId();
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export class DeviceFlowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const FRIENDLY: Record<string, string> = {
  access_denied: 'You cancelled the authorisation on GitHub.',
  expired_token: 'The code expired before it was entered. Start again.',
  device_flow_disabled: 'This OAuth app does not have device flow enabled in its settings.',
  incorrect_client_credentials: 'That GitHub client ID is not valid.',
  incorrect_device_code: 'The device code was rejected. Start again.',
};

async function postJson(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'marky-mcmarkface' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const id = clientId();
  if (!id) {
    throw new DeviceFlowError(
      'no_client_id',
      'Marky McMarkface has no GitHub client ID configured yet. Run setup, or connect with the GitHub CLI.',
    );
  }
  const body = await postJson(DEVICE_CODE_URL, { client_id: id, scope: SCOPES });
  if (typeof body.error === 'string') {
    throw new DeviceFlowError(body.error, FRIENDLY[body.error] ?? String(body.error_description ?? body.error));
  }
  return body as unknown as DeviceCode;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the user approves. Sleeps *before* the first poll — GitHub is strict about the
 * interval and an eager first request immediately earns a `slow_down`.
 */
export async function pollForToken(device: DeviceCode, signal?: AbortSignal): Promise<string> {
  const id = clientId();
  if (!id) throw new DeviceFlowError('no_client_id', 'Marky McMarkface has no GitHub client ID configured yet.');

  let interval = device.interval;
  const deadline = Date.now() + device.expires_in * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DeviceFlowError('aborted', 'Sign-in was cancelled.');
    await sleep(interval * 1000);

    const body = await postJson(TOKEN_URL, {
      client_id: id,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    if (typeof body.access_token === 'string') return body.access_token;

    const error = String(body.error ?? '');
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval = typeof body.interval === 'number' ? body.interval : interval + 5;
      continue;
    }
    throw new DeviceFlowError(error, FRIENDLY[error] ?? String(body.error_description ?? error));
  }

  throw new DeviceFlowError('expired_token', FRIENDLY.expired_token!);
}

/**
 * Revoke the grant so "sign out" actually severs access rather than just forgetting locally.
 * Requires the client secret; without one we can only forget the token on this machine, which
 * is what the caller falls back to.
 */
export async function revokeGrant(token: string): Promise<boolean> {
  const creds = credentials();
  if (!creds) return false;
  const { clientId: id, clientSecret: secret } = creds;
  const res = await fetch(`https://api.github.com/applications/${id}/grant`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'User-Agent': 'marky-mcmarkface',
    },
    body: JSON.stringify({ access_token: token }),
  });
  return res.status === 204;
}
