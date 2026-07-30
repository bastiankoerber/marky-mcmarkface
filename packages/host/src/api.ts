import type { DashboardData } from '@pilcrow/server/src/github/dashboard.js';
import type { PrDetail } from '@pilcrow/server/src/github/pr.js';
import type { PendingComment, ReviewEvent } from '@pilcrow/server/src/github/review.js';
import type { Prefs } from '@pilcrow/server/src/prefs.js';

export type { DashboardData, PrDetail, PendingComment, ReviewEvent, Prefs };

/**
 * Every request carries `X-Pilcrow: 1`. The server rejects anything without it, which is what makes
 * a cross-origin page unable to drive this API — a form cannot set custom headers, and a
 * cross-origin fetch that tries earns a preflight the server fails.
 */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'X-Pilcrow': '1', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    throw new Error((body as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export interface AuthStatus {
  connected: boolean;
  login: string | null;
  avatarUrl: string | null;
  scopes: string | null;
  source: 'oauth' | 'device-flow' | 'gh-cli' | 'pat' | null;
  /** True when Pilcrow can run the one-click flow. False means the app needs registering once. */
  oauthConfigured: boolean;
  deviceFlowConfigured: boolean;
  /** Prefilled GitHub form, used only when oauthConfigured is false. */
  registrationUrl: string;
  gh: {
    available: boolean;
    loggedIn: boolean;
    login?: string;
    scopes?: string;
    excessScopes?: string[];
    reason?: string;
  };
}

export interface DeviceStart {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
}

export const api = {
  authStatus: () => call<AuthStatus>('/api/auth/status'),
  oauthStart: () => post<{ url: string }>('/api/auth/oauth/start'),
  oauthConfigure: (clientId: string, clientSecret: string) =>
    post<{ ok: true }>('/api/auth/oauth/configure', { clientId, clientSecret }),
  connectGh: () => post<{ login: string }>('/api/auth/gh'),
  connectPat: (token: string) => post<{ login: string }>('/api/auth/pat', { token }),
  deviceStart: () => post<DeviceStart>('/api/auth/device/start'),
  deviceCancel: () => post<{ ok: true }>('/api/auth/device/cancel'),
  signOut: () => post<{ ok: true }>('/api/auth/signout'),

  dashboard: () => call<DashboardData & { prefs: Prefs; staleError?: string | null }>('/api/dashboard'),
  refresh: () => post<DashboardData>('/api/dashboard/refresh'),
  setFocus: (focused: boolean) => post<{ ok: true }>('/api/focus', { focused }),

  prefs: () => call<Prefs>('/api/prefs'),
  savePrefs: (patch: Partial<Prefs>) => post<Prefs>('/api/prefs', patch),

  pr: (owner: string, repo: string, number: number) => call<PrDetail>(`/api/pr/${owner}/${repo}/${number}`),
  submitReview: (
    owner: string,
    repo: string,
    number: number,
    input: { event: ReviewEvent; body: string; comments: PendingComment[] },
  ) => post<{ id: number; url: string }>(`/api/pr/${owner}/${repo}/${number}/review`, input),
  reply: (owner: string, repo: string, number: number, commentId: number, body: string) =>
    post<unknown>(`/api/pr/${owner}/${repo}/${number}/reply`, { commentId, body }),
  resolveThread: (threadId: string, resolved: boolean) =>
    post<{ resolved: boolean }>('/api/thread/resolve', { threadId, resolved }),
};

/** Server-pushed updates. The server does the polling; this just listens. */
export function subscribe(handlers: Record<string, (data: unknown) => void>): () => void {
  const source = new EventSource('/api/events');
  const bound: Array<[string, EventListener]> = [];
  for (const [event, handler] of Object.entries(handlers)) {
    const listener: EventListener = (e) => {
      try {
        handler(JSON.parse((e as MessageEvent).data));
      } catch {
        /* ignore malformed frames rather than tearing down the stream */
      }
    };
    source.addEventListener(event, listener);
    bound.push([event, listener]);
  }
  return () => {
    for (const [event, listener] of bound) source.removeEventListener(event, listener);
    source.close();
  };
}
