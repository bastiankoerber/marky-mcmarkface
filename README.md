<div align="center">

<img src="packages/host/public/icons/icon-192.png" width="112" height="112" alt="Marky McMarkface logo" />

# Marky McMarkface

**Review Markdown pull requests the way they will be read.**

A local-first reviewer for GitHub pull requests that contain Markdown. Rendered rich diff,
file tree, and drag-select prose comments that post as real GitHub review comments.

</div>

---

GitHub renders Markdown beautifully in its rich diff, and then will not let you comment on it.
So documentation review happens against raw diffs — reading `+` and `−` and mentally rebuilding
the page — or it happens in Google Docs and never makes it back into the repository.

Marky McMarkface is the missing half: the rendered view, with commenting.

## Installation

### Desktop application for macOS

The desktop build installs as an ordinary **Marky McMarkface.app**: its own window, Dock icon,
Application Support directory, and no terminal or browser tab. Download the `.dmg` from Releases
when one is published, or build it locally:

```bash
pnpm install
pnpm desktop:make
open packages/desktop/out/make
```

Publishing a GitHub release can build and attach the installer automatically. Maintainer setup
and the release checklist are in [docs/releasing.md](docs/releasing.md).

Signed desktop releases check GitHub directly for updates and ask before downloading or
restarting. Development builds never replace themselves automatically.

The current unsigned prerelease is not notarized, so macOS may refuse to open it even after you
drag the app from the DMG into **Applications**. If you downloaded the DMG from this repository
and verified its checksum against `SHA256SUMS.txt`, remove quarantine from this app only:

```bash
xattr -dr com.apple.quarantine "/Applications/Marky McMarkface.app"
```

Then open **Marky McMarkface** normally. This command bypasses Gatekeeper for that copy of the
app; do not run it on an installer from somewhere you do not trust. Signed and notarized public
releases will not require this step.

### Local web installation

The original development-friendly installation remains available:

```bash
pnpm install
pnpm dev
```

Then connect your GitHub account and start reviewing. Both installations run entirely on your
machine; there is no hosted Marky McMarkface service and nothing leaves your Mac except calls to
GitHub.

## What it does

**Reads like a document.** The page is set in Newsreader at a book measure on warm paper, not in
UI font at 14px. Changes are marked the way an editor marks a printed proof — a change bar in
the margin, insertions underlined, deletions struck through — rather than as pastel diff blocks,
which hurt readability behind prose. Toggle to *Final* for the clean read, or *Source* for the
raw hunks. `[` and `]` collapse the file tree and the margin; with both hidden it is just the
page.

**Comment on prose, not on lines.** Select any passage and write a note. Marky McMarkface works out which
source lines you meant and posts a normal GitHub review comment there. Existing threads appear
in the margin beside the text they refer to, with replies and resolve.

**Shows the document's images.** Relative and reference-style Markdown images are resolved from
the exact pull-request commit, falling back to the exact base commit when the branch is behind,
including in private repositories. Missing or blocked images get an explicit placeholder;
arbitrary external images remain blocked so opening a document cannot be used as a tracking pixel.

**Nothing is sent until you submit.** Comments collect into one review, the way GitHub's own
review model works — the author gets a single notification rather than a drip of emails while
you read. Drafts survive a reload and are listed on the dashboard, so an unsubmitted review is
never mistaken for feedback already given. If new commits land while you were writing, the
drafts are dropped rather than re-pinned to lines that have since moved, and Marky McMarkface says so.

**Light, dark, or whatever your Mac is doing.** Three-state switch in the top bar. Dark is warm
rather than blue-black, and the paper grain is light-mode only.

**Knows what is waiting for you.** One dashboard across every repository: pull requests awaiting
your review, your open ones, and recent activity — with the Markdown-heavy ones badged, since
those are the ones worth opening here.

**Refuses to fail confusingly.** GitHub only accepts comments on lines inside the diff, so
unchanged prose says so instead of letting you write a comment that gets rejected on submit.

## Connecting

Marky McMarkface ships with the public Client ID of its GitHub OAuth app, so users never have to
register an application or paste configuration into the app. If you have the GitHub CLI
authenticated — `gh auth status` — the first screen offers **Continue as @you** and that is the
whole flow. It reuses the authorisation you already granted `gh`; no codes or credentials to
paste. Without the CLI, **Connect GitHub** starts GitHub's device flow using the bundled app.

If `gh` is not set up, or your org blocks it, two other ways in:

- **Paste a fine-grained token** — good for GitHub Enterprise Server, or orgs that do not permit
  OAuth apps. Needs *Pull requests: read and write* on the repositories you review.
- **Use your own OAuth app** — optional for forks or organisations that do not permit the bundled
  app. Set its Client ID in `.env`; adding its client secret enables one-click browser sign-in,
  while leaving the secret empty uses device codes.

A fork can replace `BUNDLED_CLIENT_ID` in `packages/server/src/auth/oauth.ts` with its own public
Client ID. The bundled value is an application identifier, not a credential; no client secret is
committed.

Marky McMarkface requests `repo` and `read:org` — the minimum classic OAuth scopes that support
private pull requests and posting reviews, though `repo` authorises more than the application
implements. The desktop app explains that distinction before opening GitHub. After GitHub
approves, you can encrypt the token with a key protected by macOS Keychain or keep it in memory
only until the app quits. The local web installation uses the native keyring when available (or
`~/.marky-mcmarkface/token.json`, mode 0600, as its documented fallback). The token never reaches
the browser in either installation.

Company organisations may require an owner to
[approve the OAuth app](https://docs.github.com/en/account-and-profile/how-tos/organization-membership/requesting-organization-approval-for-oauth-apps).
For a classic personal access token, authorize the organisation under
[Configure SSO](https://docs.github.com/authentication/authenticating-with-saml-single-sign-on/authorizing-a-personal-access-token-for-use-with-saml-single-sign-on).
A fine-grained token must name the organisation as its resource owner, select the required
repositories, and may remain pending until an owner approves it. Organisation or enterprise
policy can also block PAT access completely; Marky McMarkface cannot bypass that policy.

When secure desktop storage is chosen, macOS may ask for access to **“Marky McMarkface Safe
Storage”**. The app shows an explanation before triggering that dialog. Its password field belongs
to macOS; Marky McMarkface cannot see or store the Mac login password. Choosing **Deny** stores
nothing and leaves the session-only option available.

**Marky McMarkface will never ask you to paste a token in order to "reconnect".** If you see that, it did
not come from us.

## Extending it

Viewers are the extension point. Markdown gets the rendered rich diff; everything else falls back
to a source diff. If you review BPMN, notebooks, CSV, AsciiDoc or OpenAPI, you can add a viewer
for it — a first one is about fifty lines, and it does not have to understand the anchoring
system.

**→ [docs/writing-a-viewer.md](docs/writing-a-viewer.md)**

Each viewer is lazily loaded, so adding a heavy one never costs anything to people who don't
open that file type.

## How it works

The load-bearing idea:

```
DOM Selection ──[ viewer plugin ]──▶ source offsets ──[ host ]──▶ GitHub (path, line, side)
```

The host owns the document and the annotations. A viewer renders, and reports source character
offsets. It never learns about GitHub, diff hunks, or line numbers — all of that lives in one
place.

Getting that mapping right is the whole product, and it has no visible failure mode: a comment
placed three characters off looks exactly like a correct one until it confuses somebody weeks
later. So it is measured rather than assumed — see **[docs/anchoring.md](docs/anchoring.md)** for
the gate, the numbers, and why it is graded in source lines rather than characters.

```
packages/
├─ viewer-api/          the published contract — types + pure helpers, no deps
├─ host/                React app: registry, dashboard, review UI, comment rail
├─ server/              Hono on 127.0.0.1: OAuth, Keychain, GitHub, polling, SSE
└─ viewers/
   ├─ markdown/         parse, position-stamping renderer, block + word diff, anchoring
   └─ source-diff/      always-available fallback; claims everything at the worst rank
```

## Commands

```bash
pnpm dev                          # API on 127.0.0.1:7423, UI on localhost:5180
pnpm vitest run                   # unit tests
pnpm spike:anchoring --offline    # the anchoring gate, against committed fixtures
pnpm build                        # production bundle; the server then serves it single-origin
npx tsc --noEmit -p tsconfig.json
```

## Status

Early, and honest about it. Reviewing works end to end against live pull requests.

Not yet done: no bundled client ID (see Connecting); suggested edits have a model but no UI;
viewed-state lives in component state and is lost on reload; `capabilities.safe`, `postProcess`
and `remarkPlugins` are declared in the viewer API but not yet acted on by the host; and
npm-installable third-party viewers are still build-time only.

Requires macOS, Node 20.19+, pnpm 10+.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) ·
[Security](SECURITY.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

MIT licensed.
