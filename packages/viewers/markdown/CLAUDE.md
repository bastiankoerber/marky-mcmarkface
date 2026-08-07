# `@marky-mcmarkface/viewer-markdown`

The built-in viewer, and the reference implementation of the anchoring contract.

## Invariants

**1. Never emit an offset you cannot verify.**

`exactSpan()` locates a leaf's decoded value inside the raw source it was parsed from. When that
fails — a backslash escape, a character entity — the leaf is stamped **without** `data-marky-mcmarkface-x`
and anchoring degrades to element granularity. That degradation is correct. An offset that is
quietly three characters off is not, and nothing downstream can detect it.

**2. Diff marks are applied by splitting stamped leaves, never by wrapping opaque regions.**

`emitLeaf()` cuts a text leaf at every diff boundary inside it and stamps each fragment with its
own exact offsets. This is why rich-diff rendering costs nothing in anchoring accuracy. If you
ever find yourself wrapping a region in a marker element that swallows its stamps, the diff view
and the comment system have quietly decoupled.

**3. The stamps are the whole contract.**

`anchoring.ts` reads only the stamps from the DOM. It never touches the mdast tree at runtime,
which is why it works identically on a server-rendered string and a live React tree.

**4. The position attribute is nonced. Do not un-nonce it.**

`data-` attributes survive DOMPurify, so a pull request author can write `data-marky-mcmarkface-pos`
themselves — and did, in testing: highlighting *"This release only fixes typos."* produced a
comment quoting an unrelated sentence about vendor access. The renderer therefore emits
`data-marky-mcmarkface-pos-<nonce>` with a per-render token minted in `MarkdownViewer.tsx`, carried on the
root as `data-marky-mcmarkface-nonce` (outside the sanitised HTML), and `anchoring.ts` derives the
attribute name from it. `integrity.test.ts` covers both directions, including a control that
reproduces the attack with the nonce removed.

The bare attribute name is the fallback for tests and the spike, which render without a nonce.

**5. The sanitiser config is load-bearing, and duplicated.**

`MarkdownViewer.tsx` strips `style` and `class` (a PR could otherwise hide content from the
rendered view, or overlay the Approve button) and adds `target` back — safe only because the
renderer always emits `rel`. `integrity.test.ts` mirrors this config; if you change one, change
both, or the tests stop testing what ships.

## The attributes

| Attribute | Meaning |
|---|---|
| `data-marky-mcmarkface-pos-<nonce>="<start>:<end>"` | source char span, on every element (bare name only without a nonce) |
| `data-marky-mcmarkface-x` | this element's text maps 1:1 onto `source[start..end]` |
| `data-marky-mcmarkface-change` | `added` / `removed` / `changed`, top-level blocks only |
| `data-marky-mcmarkface-nonce` | on the root, host-rendered — the key to the position attribute |

## After any change here

```bash
pnpm vitest run
pnpm spike:anchoring --offline
pnpm spike:anchoring --offline --corrupt 7   # must FAIL
```

The unit tests assert against `source.indexOf(...)` rather than against the renderer's own
stamps, so they are independent of the machinery under test. Keep new tests that way.
