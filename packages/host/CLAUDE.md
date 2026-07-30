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

**9. Waiting states go through `Loading`.**

`src/Loading.tsx` — pass a specific `line` ("Opening owner/repo #7…"), optionally a `slowLine`,
and `variant="inline"` inside an existing pane. It deliberately renders nothing for the first
180ms so fast responses do not flash. Never write a bare "Loading…" string.

## Design

The first-run screens live in `src/onboarding/`. The bar is Apple, not devtool:

- One primary button per screen. Everything else is progressive disclosure.
- Copy names what is happening. Never a bare spinner.
- Motion is 200–420ms, `ease-out`, and always disabled under `prefers-reduced-motion`.
- Empty states are sentences, not "No data".

`styles.css` holds the tokens. One accent colour; light and dark both defined.
