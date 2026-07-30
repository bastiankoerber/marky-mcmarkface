# `@pilcrow/server`

Hono, bound to `127.0.0.1` only. Owns credentials, the GitHub client, polling, and SSE.

## Invariants

**1. The token never leaves this process.**

It lives in the macOS Keychain and is attached to outbound GitHub calls here. `publicIdentity()`
exists so routes cannot return it by accident. The browser learns *who* is connected, never
*what* the credential is. This was a real bug once — `/api/auth/gh` returned the whole stored
record — so treat any new route that touches `StoredToken` with suspicion.

**2. All three localhost checks stay.**

In `middleware/security.ts`:

| Check | Stops |
|---|---|
| `Host` must be localhost | DNS rebinding |
| `Origin` must be known | cross-origin reads |
| `X-Pilcrow: 1` required on `/api/*` | CSRF — a `<form>` cannot set custom headers |

`/gh/callback` is deliberately *not* under `/api`, because a top-level navigation from GitHub
cannot send a custom header. Its authentication is the `state` parameter.

**3. Polling lives here, never in the browser.**

`Poller` owns the timer and pushes over SSE. Otherwise N open tabs multiply GitHub traffic by N.

## GitHub facts encoded in this package

Each is expensive to rediscover; the comments explaining them are load-bearing.

- Device-flow errors arrive as **HTTP 200** with an `error` body, and `slow_down` carries a new
  cumulative `interval` that must be adopted.
- A conditional request that 304s costs **zero** rate limit — but only on stable resources.
  Volatile listings never 304, so `cache: true` there is waste.
- `GET /rate_limit` reports **stale** search numbers. Trust the `X-RateLimit-*` headers on the
  actual response.
- GraphQL `search` does not draw on the REST search bucket. The dashboard is one query, cost 1.
- `gh auth token` prefers `GH_TOKEN`/`GITHUB_TOKEN` over its keyring, and those are frequently
  stale. `resolveToken()` retries with them stripped.

## Auth shape

`credentials()` requires a client id **and** secret, and selects one-click PKCE. `appClientId()`
needs only the id, and selects device flow. The secret is optional throughout, so a fork can ship
a working default without committing a credential.
