# Marky McMarkface ¶ — working in this repo

Review Markdown pull requests as rendered documents: file tree, rich diff, drag-select prose
comments that round-trip to real GitHub review comments. Local-first; there is no Marky McMarkface server.

## The one architectural rule

**The host owns the document and the annotations. A viewer renders, and reports source character
offsets.** A viewer never learns about GitHub, diff hunks, `side: LEFT|RIGHT` wire values, or
`start_line` — the host owns every bit of that translation.

```
DOM Selection ──[ viewer plugin ]──▶ source offsets ──[ host ]──▶ GitHub (path, line, side)
```

If you find yourself importing GitHub types into a viewer, stop: the design has gone wrong.

## Layout

| Package | Owns |
|---|---|
| `packages/viewer-api` | The published contract. Types + pure helpers, no deps, no React. |
| `packages/host` | React app: viewer registry, dashboard, review UI, comment rail. |
| `packages/server` | Hono on 127.0.0.1: OAuth, Keychain, GitHub client, polling, SSE. |
| `packages/viewers/markdown` | Parse, position-stamping renderer, block+word diff, anchoring. |
| `packages/viewers/source-diff` | Always-available fallback; claims `**/*` at the worst rank. |

Each package has its own `CLAUDE.md` stating the invariant it must not break. Read it before
editing that package.

## Commands

```bash
pnpm install
pnpm dev                            # API on 127.0.0.1:7423, UI on localhost:5180
pnpm vitest run                     # unit tests
pnpm spike:anchoring --offline      # the Phase 0 gate, against committed fixtures
pnpm build
npx tsc --noEmit -p tsconfig.json
```

**After touching `render.ts`, `anchoring.ts`, or anything that emits `data-marky-mcmarkface-*`, run the
gate.** It is the only thing standing between a refactor and silently misplaced review comments:

```bash
pnpm spike:anchoring --offline && pnpm spike:anchoring --offline --corrupt 7
```

The first must pass; the second must **fail**. If corrupting every stamp by 7 characters still
passes, the gate has lost its teeth and needs fixing before you trust it again.

## House style

- Comments explain *why*, especially where the code encodes a hard-won fact about GitHub's API.
  Several of those facts are invisible and expensive to rediscover — see `device-flow.ts`.
- Errors say what happened and what to do. No "Oops!", no bare spinners.
- Prefer degrading honestly over guessing. An anchor that widens to a whole block is fine; one
  that is silently three characters off is not.
- Small files, focused modules. Match the surrounding code's density and idiom.

## Things that look like bugs but are not

- `repository.language` never reports Markdown — Linguist classes it as prose. A docs repo with
  37 `.md` of 60 files reports `"Python"`. Use PR file paths instead.
- GraphQL `search` does **not** consume the REST search rate bucket. The whole dashboard is one
  query at cost 1.
- GitHub returns device-flow *errors* as HTTP **200** with an `error` body.
- Comments only work on lines inside a diff hunk. Un-commentable prose is greyed out on purpose.
