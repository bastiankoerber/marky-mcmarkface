# `@pilcrow/host`

React 19 + Vite. The viewer registry, the dashboard, and the three-pane review UI.

## Invariants

**1. `Review` stays keyed by `owner/repo/number`.**

```tsx
<Review key={`${view.owner}/${view.repo}/${view.number}`} … />
```

A hash change does not remount a component. Without this key the pending-comment buffer follows
you to the next pull request, and submitting posts those comments to the wrong PR. This was a
real bug; the key is the fix.

**2. Pending comments are addressed by id, never by array index.**

The rail shows only the active file's comments, so its indices are into a *filtered* list.
Splicing the full buffer by those indices deletes the wrong comment as soon as two files have
notes. Also a real bug once.

**3. Every viewer is `React.lazy`.**

`src/viewers/index.ts` wraps each `component` in `lazy()`, so a viewer's dependencies land in
their own Vite chunk. The build output is the check: the app entry should stay small while
`MarkdownViewer` is its own six-figure chunk. If a viewer's deps appear in the entry bundle,
someone imported it eagerly.

**4. The browser never calls GitHub.**

Everything goes through the local server, which owns the token and the polling.

**5. The document and the rail share one scroll container.**

`.reading-area` is the scroller and carries `data-pilcrow-scroll`. Giving the document and the
rail separate scrollers is what made comment cards freeze in place while the prose scrolled away
— the offsets were right, but applied in a coordinate space that never moved. `MarkdownViewer`
also finds this element via `root.closest('[data-pilcrow-scroll]')` for scroll-to-anchor, so the
attribute and the scroller must stay on the same element.

Card positions are computed in that scroller's content space:
`rect.top - scrollerRect.top + scrollTop`. Measuring from the rendered document instead puts
every card a constant ~66px too high — that is the document's own padding.

**Read `scrollTop` and the scroller's rect *inside* `topFor`, never hoisted into the enclosing
`useMemo`.** Hoisting them freezes the scroll offset at whatever it was when the memo last ran.
Selecting text does not invalidate that memo, so a reader who scrolled down and then highlighted
a phrase got a card positioned with the *stale* offset against a *current* rect — placing it
exactly `scrollTop` pixels away, beside an unrelated paragraph. Measured at −900px after a 900px
scroll. The rect and the scroll offset must be sampled together or they disagree.

**6. `.dash` needs an explicit `width: 100%`.**

Auto inline margins on a flex item disable cross-axis stretch, so `max-width` + `margin-inline:
auto` alone collapses the dashboard to fit-content and silently drops a column.

**7. The registry's answer is final.**

`Review.tsx` must use whatever `registry.resolve(path)` returns. It once called `resolve()` and
then hard-coded every non-Markdown file to the source diff, which made the entire plugin system
inert — a contributed viewer could never render. Only an explicit `source` mode overrides it.

**8. The draft comment lives in the rail, not at the cursor.**

It is a `DraftCard` sorted by position among the other cards, in the shared `.reading-area`
scroller. It used to be a fixed panel at the bottom-right, which on a wide screen sat ~950px from
the text being commented on.

**9. Unsent comments are persisted, and keyed by head SHA.**

`src/review/draftStore.ts` writes the pending buffer to `localStorage` on every change and
restores it when the review opens. A reload used to throw away an afternoon of margin notes,
which is a steep price for a model where nothing reaches GitHub until you submit.

**The stored `headSha` is load-bearing.** Comment positions are line numbers into the head file,
so a buffer written against an older commit would pin its comments to whatever text now occupies
those rows. `loadDrafts` discards a stale buffer and reports the count so the reader is told,
rather than silently restoring wrong-line comments.

Re-id on restore. The module's `commentSeq` counter restarts at `c1` on every page load, so
reusing stored ids collides with the next comment written in the session.

**10. Waiting states go through `Loading`.**

`src/Loading.tsx` — pass a specific `line` ("Opening owner/repo #7…"), optionally a `slowLine`,
and `variant="inline"` inside an existing pane. It deliberately renders nothing for the first
180ms so fast responses do not flash. Never write a bare "Loading…" string.

## Design — "Proof"

The mental model is a printed proof on a desk. The document is paper with book typography; the
chrome is a quieter desk framing it; comments are marginalia; changes are proofreader's marks.
It replaced a palette that was GitHub Primer copied verbatim, which made a product built to
beat GitHub's diff view look exactly like it.

**Four rules that hold the identity together. Breaking any one of them undoes it:**

1. **The chrome face and the document face are different.** Public Sans 13.5px for UI,
   Newsreader 18px/1.62 at a 68ch measure for the rendered Markdown. This split is the largest
   perceptual difference in the whole design — larger than the palette. Never set the document
   in the UI font.
2. **The accent is spent on one thing: the mark you are working with.** Draft card, leader line,
   focus ring, active highlight. Selected chrome — tabs, chips, the active file — is *ink*, not
   accent. An accent that appears everywhere says nothing.
3. **No background washes behind prose.** Diffs are a gutter change-bar, an underline for
   additions, a strike for deletions. A pastel fill behind 18px serif hurts the exact thing this
   app exists to make readable, and it is the loudest GitHub tell.
4. **At most two raised surfaces.** The paper and the cards. If everything is elevated, nothing
   reads as elevated.

Light is the default deliberately: the positive-polarity reading advantage is well replicated
and grows as type gets smaller. Dark is a first-class equal and is *warm* — a cool blue-black is
precisely what we are avoiding. Grain is light-mode only; on dark it reads as screen dirt.

**There is one palette, not two.** Every colour token is a `light-dark()` pair resolved against
`color-scheme`, so `src/theme.ts` switches themes by setting a single `data-theme` attribute and
nothing else has to know. Two consequences worth keeping:

- No duplicated dark block to drift out of sync with the light one. Add a colour token as a pair
  or not at all.
- No flash of the wrong theme on load, because the choice is made in CSS rather than by a script
  that runs after first paint. Do not reintroduce a `@media (prefers-color-scheme: dark)` block
  that redefines tokens — the media query belongs only in `theme.ts`, where it answers "what does
  *system* currently mean" for the viewer host.

The switch is three states, never a toggle: a two-way control cannot express "follow the system",
and once flipped it stops following it forever.

Colour is authored in **OKLCH** so the ramp is perceptually even, and borders are
`color-mix(in oklab, currentColor N%, transparent)` so a hairline sits correctly on paper, desk
*and* card — a fixed grey only ever looks right on one of them.

Onboarding still lives in `src/onboarding/`:

- One primary button per screen. Everything else is progressive disclosure.
- Copy names what is happening. Never a bare spinner — use `Loading`.
- Motion 120–320ms on `--ease`, always disabled under `prefers-reduced-motion`.
- Empty states are sentences, not "No data".

**Fonts are bundled and self-hosted** under `public/fonts/` so `font-src 'self'` holds and no CDN
learns what you are reading. If you touch them, read `public/fonts/README.md` first — the OFL's
Reserved Font Name clause is not decorative.

`styles.css` holds the tokens. One accent colour; light and dark both defined.
