# Writing a viewer

Pilcrow renders each changed file with a **viewer**. Markdown gets the rendered rich diff;
everything else falls back to a source diff. Viewers are the extension point: add one for
Mermaid, BPMN, CSV, AsciiDoc, notebooks, OpenAPI — whatever you review that deserves better than
a wall of `+` and `−`.

A first viewer is about fifty lines. You do not need to understand the anchoring system to
write one.

## The idea

The host owns the document and the comments. Your viewer renders, and — if it can — reports
**source character offsets** for what the user selected. It never sees GitHub.

```
DOM Selection ──[ your viewer ]──▶ source offsets ──[ host ]──▶ GitHub (path, line, side)
```

Everything GitHub-shaped — line numbers, `side: LEFT|RIGHT`, which lines are inside a diff hunk,
posting the review — stays in the host.

## The smallest viewer

Create `packages/viewers/csv/`:

```tsx
import { defineViewer } from '@pilcrow/viewer-api';
import type { ViewerProps } from '@pilcrow/viewer-api';

export function CsvViewer({ file }: ViewerProps) {
  const rows = (file.head ?? '').split('\n').map((line) => line.split(','));
  return (
    <table>
      <tbody>
        {rows.map((cells, i) => (
          <tr key={i}>{cells.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

export default defineViewer({
  manifest: {
    id: 'pilcrow.csv',
    displayName: 'Table',
    selector: [{ filenamePattern: '**/*.csv' }],
    capabilities: {
      sourceMapping: false,   // no prose anchoring — see below
      diff: 'new-only',
      anchorGranularity: 'block',
    },
  },
  component: CsvViewer,
});
```

Register it in `packages/host/src/viewers/index.ts`, wrapped in `React.lazy` so its dependencies
get their own chunk:

```ts
const csv = defineViewer({
  manifest: { /* as above */ },
  component: lazy(async () => ({ default: (await import('@pilcrow/viewer-csv/src/CsvViewer.js')).CsvViewer })),
});

export const builtinViewers = [markdown, csv, sourceDiff];
```

Register it, and the registry resolves it for `.csv` files. Non-Markdown files fall through to
the source diff only because that viewer claims `**/*` at rank 9000 — beat that rank and yours
opens instead.

## `sourceMapping: false` is a real answer

Declaring it means "I render, but I can't map a selection back to the source". The host then
degrades to **file-level comments** plus the source-diff panel for line comments. Everything
still works; you just don't get drag-select-on-prose.

For a diagram or a chart this is usually the right and permanent answer. Do not fake it — a
viewer that returns confident but wrong offsets puts review comments on the wrong lines, and
nothing downstream can detect that.

## Adding prose commenting

Two halves, and you need both. `registerAnchoring` tells the host where things *are*;
`host.onSelect` is what actually opens the comment composer when the reader selects something.
A viewer that implements only the first gets its existing comments positioned but can never
create a new one. See `MarkdownViewer.tsx` for the ~20 lines that wire a `mouseup` to
`host.onSelect`.

```ts
registerAnchoring({
  describe: (range) => /* DOM Range  → { side, start, end } | null */,
  anchor:   (range) => /* { start, end } → DOM Range | RectAnchor | null */,
  scrollTo: (range) => { /* bring it into view */ },
  contentContainer: () => rootElement,
  onLayoutChange: (cb) => { /* call cb when the render reflows; return teardown */ },
});
```

Two rules:

1. **Return `null` rather than a guess.** Both functions may decline. The host handles it.
2. **Degrade in width, never in position.** If you can only locate the enclosing block, return
   the block's span. A wider highlight is a UI compromise; a wrong one is a wrong review comment.

The markdown viewer does this by stamping `data-pilcrow-pos="<start>:<end>"` on every element
during render, plus `data-pilcrow-x` when that element's text maps 1:1 onto the source. See
`packages/viewers/markdown/src/render.ts` — the technique generalises to any format you render
yourself.

`RectAnchor` is defined for renderers with no DOM text range — a BPMN element, a Mermaid node, a
spreadsheet cell. Note that the host does not position cards from one yet (it looks for
`getBoundingClientRect`), so returning a `RectAnchor` today yields a mispositioned card. Return
`null` instead until that lands.

## The anchoring gate

```bash
pnpm spike:anchoring --offline
pnpm spike:anchoring --offline --corrupt 7   # must FAIL — proves the gate still has teeth
```

**Be aware of its current scope:** the harness imports the markdown viewer's `parse`, `render`
and `anchoring` modules directly, so it exercises *that* viewer only. It is not yet a generic
per-viewer conformance kit, and nothing reads your `sourceMapping` flag.

If your viewer does source mapping, test it the way `packages/viewers/markdown/src/
anchoring.test.ts` does: assert against `source.indexOf(...)` rather than against your own
stamps, so the test is independent of the machinery it is testing. Making the gate generic is a
good contribution in its own right.

## Manifest reference

| Field | Meaning |
|---|---|
| `id` | Stable unique id, e.g. `pilcrow.csv`. |
| `displayName` | Shown to the reader. Required. |
| `selector` | picomatch globs, not bare extensions. `**/docs/**/*.md` claims only docs. |
| `rank` | Lower wins. Builtins 100, contributions default 500. Source-diff sits at 9000. |
| `priority` | `'option'` never auto-opens; the user must pick it explicitly. |
| `safe` | `false` if you execute embedded content. Gates on the repo's trust decision. |
| `capabilities.diff` | `'native'` if you render your own diff; `'new-only'` if you show head only. |

Two viewers can claim the same file; the lower `rank` opens.

## Not built yet

These exist in the type definitions and are **not** acted on by the host. Do not build against
them expecting them to work; they are declared so that adding them later is additive:

| Field | Intended for | Status |
|---|---|---|
| `postProcess` | transforming the built-in render (Mermaid, KaTeX) instead of replacing it | never called |
| `remarkPlugins` | contributing into the shared parse pipeline | never read |
| `capabilities.safe` | gating viewers that execute embedded content | never read — **not a security control** |
| `capabilities.diff` / `anchorGranularity` / `editable` | host layout decisions | advisory only |
| user "open with" overrides | letting a reader pick a different viewer | `candidates()` exists, no menu calls it |

Implementing any of these in the host is a welcome contribution.

Worth stating plainly: a viewer is fully-privileged, same-origin code. It can reach the local API
that holds a `repo`-scoped GitHub token. Reviewing a contributed viewer is a security review.

## Checklist

- [ ] `pnpm vitest run` passes
- [ ] `pnpm spike:anchoring --offline` passes (and `--corrupt 7` fails)
- [ ] `npx tsc --noEmit -p tsconfig.json` clean
- [ ] Your viewer is `React.lazy`'d and `pnpm build` shows it as its own chunk
- [ ] `capabilities` are honest, especially `sourceMapping`
