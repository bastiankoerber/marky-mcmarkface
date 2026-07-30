# Security

## Reporting

Please report vulnerabilities privately via [GitHub Security
Advisories](https://github.com/pilcrow-md/pilcrow/security/advisories/new) rather than a public
issue. Expect an acknowledgement within a few days.

## Threat model

Pilcrow runs a local HTTP server that holds a GitHub token with `repo` scope. That makes it a
more interesting target than most localhost tools, and the design reflects it.

**The server is reachable by any page the user has open.** Three checks close the realistic
attacks, in `packages/server/src/middleware/security.ts`:

| Check | Stops |
|---|---|
| `Host` header must be localhost | DNS rebinding, where an attacker domain resolves to 127.0.0.1 |
| `Origin` must be a known origin | ordinary cross-origin reads |
| `X-Pilcrow: 1` required on `/api/*` | CSRF — a `<form>` cannot set custom headers, and a cross-origin `fetch` that tries earns a preflight we fail |

The server binds `127.0.0.1` only, never `0.0.0.0`.

**The token never reaches the browser.** It lives in the macOS Keychain and is attached to
outbound GitHub calls in the server process. API responses carry the login, never the credential.

**Pull request content is untrusted.** Markdown permits raw HTML, and Pilcrow renders Markdown
from arbitrary pull requests inside a page whose origin can reach a token-holding server. Output
is sanitised with DOMPurify before it reaches the DOM.

**Scopes are the minimum GitHub allows.** `repo` and `read:org`. Classic OAuth has no read-only
private-repo scope, and Pilcrow must write review comments, so `repo` is unavoidable rather than
chosen. Users who object can supply a fine-grained token instead.

## Client id and client secret in the repository

Pilcrow may ship an OAuth client id, and optionally a client secret, in source. This is
deliberate and follows GitHub's documented guidance for public clients:

> If your app is a public client (a native app that runs on the user's device, CLI utility, or
> single-page web application), you cannot secure your client secret. You will have to ship the
> client secret in the application's code.

The GitHub CLI and VS Code both do the same in their own source. Note the consequence GitHub
also names: a public client id is trivially reusable, so it can be abused as a device-code
phishing primitive against *other* people. That is why the one-click flow (authorization code +
PKCE, which binds a redirect URI) is preferred over device flow where a browser is available.

Pilcrow never reuses another product's client id.

## What is not protected

- Anyone with access to your unlocked user account on this machine can use Pilcrow, exactly as
  they could use `gh`.
- A malicious npm dependency runs with your privileges. Viewers are not sandboxed; the default
  set is kept in-repo and reviewed for that reason.
