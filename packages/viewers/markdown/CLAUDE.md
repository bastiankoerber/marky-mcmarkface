# `@pilcrow/viewer-markdown`

The built-in viewer, and the reference implementation of the anchoring contract.

## Invariants

**1. Never emit an offset you cannot verify.**

`exactSpan()` locates a leaf's decoded value inside the raw source it was parsed from. When that
fails — a backslash escape, a character entity — the leaf is stamped **without** `data-pilcrow-x`
and anchoring degrades to element granularity. That degradation is correct. An offset that is
quietly three characters off is not, and nothing downstream can detect it.

**2. Diff marks are applied by splitting stamped leaves, never by wrapping opaque regions.**

`emitLeaf()` cuts a text leaf at every diff boundary inside it and stamps each fragment with its
own exact offsets. This is why rich-diff rendering costs nothing in anchoring accuracy. If you
ever find yourself wrapping a region in a marker element that swallows its stamps, the diff view
and the comment system have quietly decoupled.

**3. The stamps are the whole contract.**

`anchoring.ts` reads only `data-pilcrow-pos` / `data-pilcrow-x` from the DOM. It never touches
the mdast tree at runtime, which is why it works identically on a server-rendered string and a
live React tree. Keep it that way.

## The attributes

| Attribute | Meaning |
|---|---|
| `data-pilcrow-pos="<start>:<end>"` | source char span, on every element |
| `data-pilcrow-x` | this element's text maps 1:1 onto `source[start..end]` |
| `data-pilcrow-change` | `added` / `removed` / `changed`, top-level blocks only |

## After any change here

```bash
pnpm vitest run
pnpm spike:anchoring --offline
pnpm spike:anchoring --offline --corrupt 7   # must FAIL
```

The unit tests assert against `source.indexOf(...)` rather than against the renderer's own
stamps, so they are independent of the machinery under test. Keep new tests that way.
