# Anchoring

Pilcrow's premise is that you select rendered prose and a review comment lands on the right
source line. This document is about how that is done and how it is checked.

## The problem

GitHub's review API anchors comments to **source line numbers** — `path`, `commit_id`, `line`,
optionally `start_line` and `side`. A reader selects a **character range in rendered prose**.
Those are different coordinate systems, and the entire tool is the bridge.

The mapping has no visible failure mode. A comment three characters off looks exactly like a
correct one, right up until a reviewer is confused by it weeks later. So it is measured.

## The mechanism

Markdown is parsed to mdast, where every node carries `position.start.offset` and
`position.end.offset` — exact character offsets into the source. The renderer stamps those onto
the DOM as it emits it:

| Attribute | Meaning |
|---|---|
| `data-pilcrow-pos="<start>:<end>"` | source char span, on every element |
| `data-pilcrow-x` | this element's text maps 1:1 onto `source[start..end]` |
| `data-pilcrow-change` | `added` / `removed` / `changed`, on top-level blocks |

`describe()` walks up from a selection to the nearest stamp; `anchor()` walks back down. Neither
touches the mdast tree at runtime, which is why the same code works on a server-rendered string
and a live React tree.

Two design decisions do most of the work:

**Leaves that cannot be verified are not stamped as exact.** `exactSpan()` locates a leaf's
decoded value inside the raw source it came from — that is what strips the backticks from
`` `code` `` and the fences from a code block. When the value was transformed during parsing (a
backslash escape, a character entity) the lookup fails, and the leaf is stamped *without*
`data-pilcrow-x`. Anchoring then degrades to element granularity. A wider highlight is a UI
compromise; a wrong offset is a wrong review comment.

**Diff marks split stamped leaves rather than wrapping regions.** When a word is marked as
inserted, the text leaf is cut at the diff boundary and each fragment keeps its own exact
offsets. This is why rich-diff rendering costs nothing in anchoring accuracy — `describe()`
behaves identically with the diff on or off.

Raw HTML blocks are passed through verbatim, so their text sits at known offsets too; the
renderer walks the block skipping tags and stamps the text runs. Without that, selecting a word
inside an HTML `<table>` — common in docs repos — anchored the entire table.

## The gate

```bash
pnpm spike:anchoring --offline              # committed fixtures, no network
pnpm spike:anchoring --repos owner/name     # real repositories
```

It renders each document, samples random selections, and grades the result.

### Why it is graded in source lines

Comparing rendered text against source text is meaningless. Any selection crossing a backtick, a
list marker, a link destination or a paragraph break renders differently from its source *by
definition* — the source has syntax the reader never sees.

An early version of this harness graded on characters and reported a 30% failure rate that was
entirely measurement artefact. Grading in lines matches what GitHub actually accepts.

### Why the ground truth is independent

`groundTruth()` never asks `describe()` anything. For every text node the selection touches, it
takes the stamp and **verifies it** — `source.slice(start, end)` must equal the text actually
rendered — before using it. A dishonest stamp is excluded rather than trusted, so `describe()`
cannot mark its own homework.

### Why there are three conditions

`correct` and `round-trip` are both blind to a uniformly wrong renderer. If every stamp were
shifted by the same amount, every stamp would fail verification, every sample would fall to
`block-only`, and `correct` would read 100%. Round-trip cannot catch it either, because
`describe()` and `anchor()` stay mutually consistent under a uniform offset error.

Hence the third condition: **`stamp-verified ≥ 90%`**. Prove it works:

```bash
pnpm spike:anchoring --offline --corrupt 7
```

Shifting every stamp by seven characters yields `correct 100.0%`, `round-trip 100.0%`,
`stamp-verified 0.0%` — **GATE FAIL**. Exactly the blindness described, caught. CI runs this and
fails the build if the corrupted run *passes*.

## Results

Real corpus — 77 Markdown files from two documentation repositories, 4,563 sampled selections:

| | |
|---|---|
| exact (≤1 extra line) | 99.3% |
| wide (>1 extra line) | 0.1% |
| block-only (no exact stamp) | 0.6% |
| **failed (wrong lines)** | **0.0%** |
| round-tripped | 100.0% |
| extra lines p50 / p90 / p99 | 0 / 0 / 0 |

Committed fixtures (what CI runs) — 294 samples, 0 failures, 97.6% stamp-verified. Smaller and
synthetic; it catches regressions rather than discovering new failure modes. Run against real
repositories before a release.

## If you change the renderer

Run both, every time:

```bash
pnpm spike:anchoring --offline && pnpm spike:anchoring --offline --corrupt 7
```

The first must pass. The second must fail. Add a fixture whenever you fix an anchoring bug, so
it cannot come back.
