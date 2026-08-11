import type { DashboardData } from '@marky-mcmarkface/server/src/github/dashboard.js';
import type { PrDetail } from '@marky-mcmarkface/server/src/github/pr.js';
import type { PendingComment, ReviewEvent } from '@marky-mcmarkface/server/src/github/review.js';
import type { Prefs } from '@marky-mcmarkface/server/src/prefs.js';

export type { DashboardData, PrDetail, PendingComment, ReviewEvent, Prefs };

export interface RepositoryFile {
  path: string;
  content: string;
  ref: string;
}

/**
 * Every request carries this launch's `X-Marky-McMarkface` key.
 *
 * The header is what makes a cross-origin page unable to drive this API — a form cannot set
 * custom headers, and a cross-origin fetch that tries earns a preflight the server fails. The
 * *value* being per-launch rather than a published constant is what stops a local one-liner
 * doing the same thing.
 *
 * In production the server injects it into the served document. In development the Vite proxy
 * attaches it, so the browser never needs it at all.
 */
const SESSION_KEY = document.querySelector<HTMLMetaElement>('meta[name="marky-mcmarkface-key"]')?.content ?? '';

function authHeaders(extra: HeadersInit = {}): HeadersInit {
  return SESSION_KEY ? { 'X-Marky-McMarkface': SESSION_KEY, ...extra } : extra;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...authHeaders({ 'Content-Type': 'application/json' }), ...(init.headers ?? {}) },
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
  /** How the active credential is held, or `locked` when an encrypted one awaits consent. */
  storage: 'none' | 'locked' | 'keychain' | 'session';
  /** A validated token held only in the server process until the user chooses storage. */
  pending: {
    login: string;
    avatarUrl: string;
    scopes: string;
    source: 'oauth' | 'device-flow' | 'gh-cli' | 'pat';
  } | null;
  /** True when Marky McMarkface can run the one-click flow. False means the app needs registering once. */
  oauthConfigured: boolean;
  deviceFlowConfigured: boolean;
  /** True inside the packaged desktop application. */
  desktop: boolean;
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
  finishConnection: (mode: 'keychain' | 'session') =>
    post<{ login: string }>('/api/auth/storage/commit', { mode }),
  cancelConnection: () => post<{ ok: true }>('/api/auth/storage/cancel'),
  unlockConnection: () => post<{ login: string }>('/api/auth/storage/unlock'),
  forgetConnection: () => post<{ ok: true }>('/api/auth/storage/forget'),
  signOut: () => post<{ ok: true }>('/api/auth/signout'),

  dashboard: () => call<DashboardData & { prefs: Prefs; staleError?: string | null }>('/api/dashboard'),
  refresh: () => post<DashboardData>('/api/dashboard/refresh'),
  setFocus: (focused: boolean) => post<{ ok: true }>('/api/focus', { focused }),

  prefs: () => call<Prefs>('/api/prefs'),
  savePrefs: (patch: Partial<Prefs>) => post<Prefs>('/api/prefs', patch),

  pr: (owner: string, repo: string, number: number) => call<PrDetail>(`/api/pr/${owner}/${repo}/${number}`),
  repositoryFile: (owner: string, repo: string, number: number, path: string) =>
    call<RepositoryFile>(
      `/api/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/file?${new URLSearchParams({ path })}`,
    ),
  submitReview: (
    owner: string,
    repo: string,
    number: number,
    input: { event: ReviewEvent; body: string; comments: PendingComment[]; commitId?: string },
  ) =>
    post<{ id: number; url: string; fileCommentsPosted: number; fileCommentErrors: string[] }>(
      `/api/pr/${owner}/${repo}/${number}/review`,
      input,
    ),
  reply: (owner: string, repo: string, number: number, commentId: number, body: string) =>
    post<unknown>(`/api/pr/${owner}/${repo}/${number}/reply`, { commentId, body }),
  resolveThread: (threadId: string, resolved: boolean) =>
    post<{ resolved: boolean }>('/api/thread/resolve', { threadId, resolved }),
};

/**
 * Server-pushed updates. The server does the polling; this just listens.
 *
 * Deliberately `fetch` + a stream reader rather than `EventSource`. `EventSource` cannot set
 * request headers, so it could never send the `X-Marky-McMarkface` key and every connection was rejected
 * — live updates had never actually worked. Exempting the path from the header check would have
 * made this stream, which carries private repository names, PR titles and file paths, readable
 * by anything that could reach it.
 */
export function subscribe(handlers: Record<string, (data: unknown) => void>): () => void {
  const controller = new AbortController();

  void (async () => {
    // Reconnect on drop, backing off, until the caller unsubscribes.
    let delay = 1000;
    while (!controller.signal.aborted) {
      try {
        const res = await fetch('/api/events', {
          headers: authHeaders({ Accept: 'text/event-stream' }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);
        delay = 1000;

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          // Frames are separated by a blank line; keep any partial tail for the next chunk.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) dispatch(frame, handlers);
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  })();

  return () => controller.abort();
}

function dispatch(frame: string, handlers: Record<string, (data: unknown) => void>): void {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  const handler = handlers[event];
  if (!handler || data.length === 0) return;
  try {
    handler(JSON.parse(data.join('\n')));
  } catch {
    /* ignore malformed frames rather than tearing down the stream */
  }
}
