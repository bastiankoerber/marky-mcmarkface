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

function CsvViewer({ file }: ViewerProps) {
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

That's a working viewer.

## `sourceMapping: false` is a real answer

Declaring it means "I render, but I can't map a selection back to the source". The host then
degrades to **file-level comments** plus the source-diff panel for line comments. Everything
still works; you just don't get drag-select-on-prose.

For a diagram or a chart this is usually the right and permanent answer. Do not fake it — a
viewer that returns confident but wrong offsets puts review comments on the wrong lines, and
nothing downstream can detect that.

## Adding prose commenting

If your format *does* have a text-to-source correspondence, implement `AnchoringImpl` and call
`registerAnchoring`:

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

`RectAnchor` exists for renderers with no DOM text range — a BPMN element, a Mermaid node, a
spreadsheet cell. Return normalised coordinates relative to an element instead of a `Range`.

## The conformance gate

If you set `sourceMapping: true`, CI runs a property test over your viewer:

```bash
pnpm spike:anchoring --offline
```

For N random source ranges it asserts `describe(anchor(r)) === r`, and separately that every
stamp you emit is honest — `source.slice(start, end)` must equal the text actually rendered.

Prove the gate can catch you before trusting it:

```bash
pnpm spike:anchoring --offline --corrupt 7   # must FAIL
```

Viewers declaring `sourceMapping: false` are skipped, not failed.

## Manifest reference

| Field | Meaning |
|---|---|
| `id` | Stable unique id, e.g. `pilcrow.csv`. Users' viewer overrides are keyed on it. |
| `selector` | picomatch globs, not bare extensions. `**/docs/**/*.md` claims only docs. |
| `rank` | Lower wins. Builtins 100, contributions default 500. Source-diff sits at 9000. |
| `priority` | `'option'` never auto-opens; the user must pick it explicitly. |
| `safe` | `false` if you execute embedded content. Gates on the repo's trust decision. |
| `capabilities.diff` | `'native'` if you render your own diff; `'new-only'` if you show head only. |

Two viewers can claim the same file — the lower `rank` opens, and both appear in "open with".

## The cheaper tier

If you only want to *transform* the built-in markdown rendering — Mermaid, KaTeX, PlantUML —
don't write a viewer. Ship a `postProcess` instead:

```ts
export default defineViewer({
  manifest: { /* … */ },
  component: null,
  postProcess: (el) => { /* mutate the rendered DOM in place */ },
});
```

Anchoring keeps working, because the markdown viewer is still the one rendering.

## Checklist

- [ ] `pnpm vitest run` passes
- [ ] `pnpm spike:anchoring --offline` passes (and `--corrupt 7` fails)
- [ ] `npx tsc --noEmit -p tsconfig.json` clean
- [ ] Your viewer is `React.lazy`'d and `pnpm build` shows it as its own chunk
- [ ] `capabilities` are honest, especially `sourceMapping`
