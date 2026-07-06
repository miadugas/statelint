# statelint — Positioning Brief

**One-liner:** An architecture linter for React state — across every state tool, on every PR.

## The problem

Modern React apps spread state across Context, Redux/RTK, RTK Query, Zustand, TanStack
Query, and local `useState`. No single dev owns the whole picture. Over time, with
multiple hands in the code, state placement rots: server data cached in three places,
props drilled four levels, "global" state read by one component. It becomes an albatross —
and no tool tells you, because every tool inspects one silo.

## The vacant lane

There is no _source-of-truth auditor_ for React state — a tool that reasons about all
state libraries as **one system**, across the **whole app**, **continuously in CI**, and
tells you **where each piece of state should actually live**.

Existing tools answer _"what is happening?"_ This one answers _"is your state
architecture right — and what should it be?"_

## Why the lane is empty

Every competitor is a single-axis inspector:

| Tool                         | Lane it owns                     | Structural blind spot                                           |
| ---------------------------- | -------------------------------- | --------------------------------------------------------------- |
| React DevTools Profiler      | One session, one dev, runtime    | Doesn't model the state libraries as a system; no CI; no advice |
| React Scan                   | "What's re-rendering right now"  | Render-only; zero architecture; runtime-only                    |
| Why Did You Render           | Avoidable renders via props diff | Render-only; noisy; no CI                                       |
| ESLint (react-hooks, etc.)   | Single-_file_ syntactic rules    | Can't see across files — by design                              |
| Redux/Zustand/Query devtools | Inspect _one_ store              | Siloed — none see across the other tools                        |
| Madge / dependency-cruiser   | Import-level module graph        | Understands imports, not state semantics                        |

## The wedge (why it's defensible)

The un-copied hard part is the **cross-library state model + placement classification +
recommendation engine**.

- React Scan won't enter it — its identity is zero-config visual; architecture analysis is
  the opposite philosophy.
- ESLint can't — file-scoped by design; a cross-component state graph isn't a lint rule.
- The per-library devtools won't — each is vendor-siloed.

## The four axes — it must have all of them at once

1. **Cross-library** — every state tool as one graph; classify each source
   `server-cache` / `global-client` / `local` / `derived`.
2. **Whole-app** — cross-file, cross-component graph (not per-file lint).
3. **Continuous** — runs headless in CI on every PR; stops re-accumulation.
4. **Prescriptive** — names the refactor, ships the codemod.

## Anti-goals (so it never drifts back into "another profiler")

- ❌ Not a re-render visualizer (React Scan)
- ❌ Not a single-session in-browser profiler (React DevTools)
- ❌ Not per-library inspection (Redux/Zustand/Query devtools)
- ❌ Not file-scoped lint rules (ESLint)
- ❌ Runtime is an _enrichment_ layer for ranking, never the architecture
