# statelinter — Positioning Brief

**One-liner:** An architecture linter for React and Vue state — across every state tool, on every PR.

## The problem

Modern React apps spread state across Context, Redux/RTK, RTK Query, Zustand, TanStack
Query, and local `useState`. Modern Vue apps run the same rot with `ref`/`reactive`,
Pinia, Vuex, provide/inject, vue-query, and Nuxt's data-fetching composables. No single
dev owns the whole picture in either ecosystem. Over time, with multiple hands in the
code, state placement decays: server data cached in three places, props drilled four
levels, "global" state read by one component. It becomes an albatross — and no one tool
tells you, because every tool inspects one silo, in one framework.

## The vacant lane

There is no _source-of-truth auditor_ for frontend state — a tool that reasons about
all state libraries as **one system**, across the **whole app**, **continuously in
CI**, and tells you **where each piece of state should actually live**. Same rot, two
ecosystems — the lane gets wider once Vue's on the table, not narrower.

Existing tools answer _"what is happening?"_ This one answers _"is your state
architecture right — and what should it be?"_

## Why the lane is empty

Every competitor is a single-axis inspector:

| Tool                         | Lane it owns                                          | Structural blind spot                                           |
| ---------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| React DevTools Profiler      | One session, one dev, runtime                         | Doesn't model the state libraries as a system; no CI; no advice |
| React Scan                   | "What's re-rendering right now"                       | Render-only; zero architecture; runtime-only                    |
| Why Did You Render           | Avoidable renders via props diff                      | Render-only; noisy; no CI                                       |
| Vue DevTools                 | One session, one dev, runtime                         | Same shape as React DevTools — no CI, no advice                 |
| Pinia devtools               | One store's state and mutations                       | Vendor-siloed — doesn't see Vuex, provide/inject, or the URL    |
| ESLint (react-hooks, etc.)   | Single-_file_ syntactic rules                         | Can't see across files — by design                              |
| eslint-plugin-vue            | Single-_file_ syntactic rules (SFC template + script) | Same by-design limit as core ESLint — no cross-file graph       |
| Redux/Zustand/Query devtools | Inspect _one_ store                                   | Siloed — none see across the other tools                        |
| Madge / dependency-cruiser   | Import-level module graph                             | Understands imports, not state semantics                        |

## The wedge (why it's defensible)

The un-copied hard part is the **cross-library state model + placement classification +
recommendation engine**.

- React Scan won't enter it — its identity is zero-config visual; architecture analysis
  is the opposite philosophy.
- ESLint / eslint-plugin-vue can't — file-scoped by design; a cross-component state
  graph isn't a lint rule.
- The per-library devtools won't — each is vendor-siloed, one framework, one store.

## Why these rules

statelinter invented none of its opinions. It made the ecosystem's existing canon
enforceable — rules that already live in docs and blog posts, that nobody runs.

- **Framework canon.** `derived-state-as-state` is React's "You Might Not Need an
  Effect" and Vue's computed-over-watchers docs, as a check instead of a paragraph.
  `server-state-in-client-state` is the TanStack/TkDodo server-state-is-not-client-state
  doctrine. `prop-drilling` is React's "Passing Data Deeply" and Vue's provide/inject
  guidance. The memo rules are React's own memo caveats, enforced instead of hoped for.
- **Community doctrine.** `over-globalized-state` is state colocation, Kent C. Dodds's
  argument made structural. `over-broad-selector` is the Redux Style Guide and
  Zustand's own selector guidance. `multiple-sources-of-truth` is the single-source-of-
  truth principle every store library preaches and none of them check for you.
- **Dogfood hardening.** Every guard and hedge — accumulator setters excluded,
  prefilled drafts softened, updater-form `set(prev => …)` excluded — came from a false
  positive on a production codebase and became a permanent regression test.

The rules aren't new. What's new is where they run: cross-file, cross-library, in CI —
not in a doc nobody rereads before they ship.

## The four axes — it must have all of them at once

1. **Cross-library** — every state tool as one graph; classify each source
   `server-cache` / `global-client` / `local` / `derived`.
2. **Whole-app** — cross-file, cross-component graph (not per-file lint).
3. **Continuous** — runs headless in CI on every PR; stops re-accumulation.
4. **Prescriptive** — names the refactor, ships the codemod.

## Anti-goals (so it never drifts back into "another profiler")

- ❌ Not a re-render visualizer (React Scan)
- ❌ Not a single-session in-browser profiler (React DevTools, Vue DevTools)
- ❌ Not per-library inspection (Redux/Zustand/Query/Pinia devtools)
- ❌ Not file-scoped lint rules (ESLint, eslint-plugin-vue)
- ❌ Runtime is an _enrichment_ layer for ranking, never the architecture
