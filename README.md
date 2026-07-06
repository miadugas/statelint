# statelint

**An architecture linter for React state — across every state tool, on every PR.**

Every existing tool answers _"what is happening?"_ (this component re-rendered, this
store changed). statelint answers _"is your state architecture right — and what should
it be?"_ — across Context, Redux/RTK, RTK Query, Zustand, TanStack Query, and local
state, over the whole app, continuously in CI.

It's not a profiler. It's the category that doesn't exist yet: a **source-of-truth
auditor** that sits _above_ the per-library devtools.

## The four axes (it needs all of them)

1. **Cross-library** — models every state tool as one graph; classifies each source as
   `server-cache` / `global-client` / `local` / `derived`.
2. **Whole-app** — a cross-file, cross-component graph (not per-file lint).
3. **Continuous** — runs headless in CI on every PR; stops the mess from re-accumulating.
4. **Prescriptive** — names the refactor and ships the codemod.

## Status

Early scaffold. The core model — [`src/graph/schema.ts`](src/graph/schema.ts) — is
locked. Detectors are built against it as pure graph queries.

See [`docs/positioning.md`](docs/positioning.md) and
[`docs/detector-map.md`](docs/detector-map.md).

## Anti-goals

- ❌ Not a re-render visualizer (React Scan)
- ❌ Not a single-session in-browser profiler (React DevTools)
- ❌ Not per-library inspection (Redux/Zustand/Query devtools)
- ❌ Not file-scoped lint rules (ESLint)

Runtime data (the React Fiber hook) is an _enrichment_ layer for ranking findings by real
impact — never the architecture.
