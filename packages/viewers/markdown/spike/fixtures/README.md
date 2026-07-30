# Gate fixtures

Hand-written Markdown that exercises the constructs most likely to break source-offset mapping.
Committed so `pnpm spike:anchoring --offline` runs in CI with no network and no GitHub token.

These are deliberately synthetic. They are not a substitute for running the gate against real
repositories — use `pnpm spike:anchoring --repos owner/name` for that before a release — but
they are a substitute for having no gate at all on a contributor's pull request.

Add a fixture whenever you fix an anchoring bug, so it cannot come back.
