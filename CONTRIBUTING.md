# Contributing to Pilcrow

Thanks for looking. The most valuable contribution is usually a **new viewer** — see
[docs/writing-a-viewer.md](docs/writing-a-viewer.md); a first one is about fifty lines.

## Setup

```bash
git clone <your fork>
cd pilcrow
pnpm install
pnpm dev          # API on 127.0.0.1:7423, UI on localhost:5180
```

Node 20.19+ and pnpm 10+. On first run, connect with the GitHub CLI button if you have `gh`
authenticated — that needs no configuration at all.

## Before you open a pull request

```bash
npx tsc --noEmit -p tsconfig.json
pnpm vitest run
pnpm build
```

And if you touched the renderer, anchoring, or anything emitting `data-pilcrow-*`:

```bash
pnpm spike:anchoring --offline
pnpm spike:anchoring --offline --corrupt 7   # this one must FAIL
```

CI runs all of these.

## The one rule

**The host owns the document and the annotations. A viewer renders, and reports source character
offsets.** A viewer never learns about GitHub, diff hunks, `side: LEFT|RIGHT`, or `start_line`.

If a change makes a viewer import GitHub types, it is going the wrong way.

## What the gate is protecting

Pilcrow's whole premise is that you select rendered prose and a comment lands on the right source
line. That mapping has no visible failure mode — a comment three characters off looks exactly
like a comment that is correct, until a reviewer is confused by it weeks later.

So: **never emit an offset you cannot verify.** Degrade to a wider highlight instead. A block-
level anchor is a UI compromise; a wrong one is a wrong review comment. The gate exists to catch
the difference, and `--corrupt` exists to prove the gate still can.

## Style

- Comments explain *why*. Several comments encode facts about GitHub's API that cost real effort
  to discover — if you remove one, make sure the fact is no longer true.
- Errors say what happened and what to do next. No "Oops!". No bare spinners.
- Match the density and idiom of the surrounding code.
- Small, focused files.

## Reporting a bug

Include the pull request URL if the problem involves a specific PR, and say whether the file
rendered in **Rich diff**, **Final**, or **Source**. Anchoring problems are almost always
specific to a markdown construct, so the smallest `.md` snippet that reproduces it is worth more
than a screenshot.

## Security

Please do not open a public issue for a security problem — see [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
