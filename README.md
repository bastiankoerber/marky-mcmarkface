<div align="center">

# ¶ Pilcrow

**Review Markdown pull requests the way they will be read.**

A local-first reviewer for GitHub pull requests that contain Markdown. Rendered rich diff,
file tree, and drag-select prose comments that post as real GitHub review comments.

</div>

---

GitHub renders Markdown beautifully in its rich diff, and then will not let you comment on it.
So documentation review happens against raw diffs — reading `+` and `−` and mentally rebuilding
the page — or it happens in Google Docs and never makes it back into the repository.

Pilcrow is the missing half: the rendered view, with commenting.

```bash
pnpm install
pnpm dev
```

Then connect your GitHub account and start reviewing. Everything runs on your machine; there is
no Pilcrow server and nothing leaves your Mac except calls to GitHub.

## What it does

**Reads like a document.** The page is set in Newsreader at a book measure on warm paper, not in
UI font at 14px. Changes are marked the way an editor marks a printed proof — a change bar in
the margin, insertions underlined, deletions struck through — rather than as pastel diff blocks,
which hurt readability behind prose. Toggle to *Final* for the clean read, or *Source* for the
raw hunks. `[` and `]` collapse the file tree and the margin; with both hidden it is just the
page.

**Comment on prose, not on lines.** Select any passage and write a note. Pilcrow works out which
source lines you meant and posts a normal GitHub review comment there. Existing threads appear
in the margin beside the text they refer to, with replies and resolve.

**Knows what is waiting for you.** One dashboard across every repository: pull requests awaiting
your review, your open ones, and recent activity — with the Markdown-heavy ones badged, since
those are the ones worth opening here.

**Refuses to fail confusingly.** GitHub only accepts comments on lines inside the diff, so
unchanged prose says so instead of letting you write a comment that gets rejected on submit.

## Connecting

**This repository does not ship a GitHub client ID yet**, so the one-click browser flow is not
available on a fresh clone. In order of least effort:

1. **GitHub CLI** — if `gh` is authenticated, the first screen offers *Continue as @you*. Nothing
   to configure. This is the path to use today.
2. **Register once** — the setup screen walks through creating an OAuth app and pasting the
   client ID back into the app. One minute, once per machine. Supply a client secret too and
   sign-in becomes one click with no codes; leave it out and Pilcrow uses device codes, which
   need no secret.
3. **Paste a token** — for GitHub Enterprise Server, or orgs that block OAuth apps.

Once a maintainer registers the project's own app and commits its client ID to
`BUNDLED_CLIENT_ID` in `packages/server/src/auth/oauth.ts`, everyone gets (1) with no setup —
which is what `gh` and VS Code do with their own IDs.

Pilcrow requests `repo` and `read:org` — the minimum GitHub offers, since classic OAuth has no
read-only private scope and posting reviews requires write. Your token goes into the macOS
Keychain (or `~/.pilcrow/token.json`, mode 0600, if the native keyring module is unavailable) and
never reaches the browser.

**Pilcrow will never ask you to paste a token in order to "reconnect".** If you see that, it did
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
[Security](SECURITY.md)

MIT licensed.
