# `@marky-mcmarkface/viewer-api`

**This package is published and implemented by third parties. Changing an exported type is a
breaking change.** Treat every `export` here as public API, including the shape of
`AnchoringImpl` and `ViewerManifest`.

## What belongs here

- Types shared between the host and viewer plugins.
- Pure helpers that both sides must agree on exactly — `offsetToLine`, `lineToOffset`,
  `quoteFor`. Duplicating these in the host would let the two drift apart, which is precisely
  the failure mode that misplaces a review comment.

## What must never go here

- React. This package stays framework-free at runtime so a viewer can be written in anything.
- Any GitHub concept: no `line`, no `side`, no hunks, no tokens. The vocabulary is source
  character offsets and nothing else.
- Runtime dependencies. It has none, deliberately, so depending on it is free.

## Adding to the contract

Additive changes (a new optional field, a new capability flag) are safe. Anything else needs a
major version and a note in `docs/writing-a-viewer.md`, because a contributed viewer in another
repo will break.
