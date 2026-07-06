# statelint

**An architecture linter for React state — across every state tool, on every PR.**

Every existing tool answers _"what is happening?"_ (this component re-rendered, this
store changed). statelint answers _"is your state architecture right — and what should
it be?"_ — across Context, Redux/RTK, RTK Query, Zustand, TanStack Query, and local
state, over the whole app, continuously in CI.

It's not a profiler. It's a **source-of-truth auditor** that sits _above_ the
per-library devtools: it models every state source in your app as one graph and flags
the placement mistakes that accumulate when several devs touch the same code.

## Usage

```sh
statelint src/                 # pretty output, exit 1 on findings (CI gate)
statelint src/ --json          # machine-readable findings
statelint src/ --min-drill 3   # tune the prop-drilling threshold
```

```
src/App.tsx
  3:7  warn  prop-drilling  Prop 'orders' drills through 2 components that never read it (Shell → Main) before reaching OrderList.
         ↳ Move this state to Context or a store, or restructure with composition (pass children instead of data).
  4:8  warn  server-state-in-client-state  'orders' holds server data (fetched in an effect) but lives in useState — a hand-rolled cache with no dedup, refetch, or staleness handling.
         ↳ Move to TanStack Query (or RTK Query in Redux apps): useQuery replaces the useState + useEffect + fetch triple.

✖ 2 problems
```

## What it catches today

| Rule                           | Fires when                                                                                                                                  | Recommends                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `multiple-sources-of-truth`    | The same entity has 2+ global owners (`UserContext` + `useUserStore`), or is server-cached in 2+ places (a query + hand-rolled fetch state) | Consolidate on one owner                            |
| `server-state-in-client-state` | `useState` fed by fetch/await/axios inside `useEffect`                                                                                      | TanStack / RTK Query                                |
| `prop-drilling`                | A prop passes through N components that never read it — cross-file, with the blind intermediates named                                      | Context, store, or composition                      |
| `over-globalized-state`        | A context or store consumed by exactly one component; provided-but-unconsumed contexts                                                      | Colocate / delete                                   |
| `over-broad-selector`          | Bare `useStore()` or identity selector on a zustand store                                                                                   | Narrow the selector (using the store's real fields) |

## What it understands

- **Local state** — `useState` / `useReducer`, with reads/writes/declares tracking
- **Context** — `createContext`, `<Ctx.Provider>` + React 19 `<Ctx value>`, `useContext`/`use`, **and consumption through custom hooks** (`useLock()` wrapping `useContext` attributes to callers, transitively)
- **Zustand** — `create()` + curried `create<T>()()`, selector vs whole-store reads, `setState` writes
- **Redux/RTK** — `createSlice` (identity = slice name), `useSelector`/`useAppSelector` state-path resolution, `dispatch` conventions
- **RTK Query** — `createApi` query endpoints, generated `useGetXQuery` hooks
- **TanStack Query** — v5 object + v4 positional forms, **identity = query key** (call sites sharing a key share one source, like the real cache)
- **Cross-file** — components, contexts, stores, and hooks resolve through default/named/aliased imports and `index.*` re-exports; same-named locals in different files never collide

All detection is static — no build step, no browser, no instrumentation. That's what
makes it runnable headless in CI on every PR.

## Design rules (the trust contract)

1. **Detectors are pure graph queries.** All AST work happens once, in the graph
   builder; detectors read `sources`/`edges` only.
2. **Never guess.** Generic entity names (`data`, `state`, `app`) are suppressed, not
   matched. Dynamic query keys get no source. Unclassifiable state is `unknown` and
   never auto-recommended on.
3. **Silence beats lying.** Zero-reader zustand stores aren't flagged (getState()
   outside components isn't tracked yet). A finding you can't trust is worse than no
   finding.

## Status

Early but real: 71 tests, dogfooded on a production PWA (where its first false
positive — context consumption hidden behind a custom hook — became the hook-analysis
feature and a regression test). Not yet published to npm.

Docs: [positioning brief](docs/positioning.md) · [detector map](docs/detector-map.md)

## Anti-goals

- ❌ Not a re-render visualizer (React Scan)
- ❌ Not a single-session in-browser profiler (React DevTools)
- ❌ Not per-library inspection (Redux/Zustand/Query devtools)
- ❌ Not file-scoped lint rules (ESLint)

Runtime data (the React Fiber hook) is a planned _enrichment_ layer for ranking
findings by real impact — never the architecture.
