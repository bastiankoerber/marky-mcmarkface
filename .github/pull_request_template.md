## What this changes

<!-- One or two sentences. -->

## Why

<!-- The problem it solves. Link an issue if there is one. -->

## Checks

- [ ] `npx tsc --noEmit -p tsconfig.json`
- [ ] `pnpm vitest run`
- [ ] `pnpm build`

If you touched the renderer, anchoring, or anything emitting `data-marky-mcmarkface-*`:

- [ ] `pnpm spike:anchoring --offline` passes
- [ ] `pnpm spike:anchoring --offline --corrupt 7` **fails** (the gate still has teeth)

If you added a viewer:

- [ ] It is `React.lazy`'d and appears as its own chunk in the build output
- [ ] `capabilities.sourceMapping` is honest — it reports offsets, or declares that it cannot
