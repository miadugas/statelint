# statelint

**An architecture linter for React state — across every state tool, on every PR.**

Every existing tool answers _"what is happening?"_ (this component re-rendered, this
store changed). statelint answers _"is your state architecture right — and what should
it be?"_ — across Context, Redux/RTK, RTK Query, Zustand, TanStack Query, URL params,
web storage, cookies, and local state, over the whole app, continuously in CI.

It's not a profiler. It's a **source-of-truth auditor** that sits _above_ the
per-library devtools: it models every state source in your app as one graph and flags
the placement mistakes that accumulate when several devs touch the same code.

All detection is static — no build step, no browser, no instrumentation. That's what
makes it runnable headless in CI on every PR.

---

## Install

Not on npm yet. Run it straight from the repo:

```sh
git clone https://github.com/miadugas/statelint && cd statelint
npm install
npm run build
npm link          # puts `statelint` on your PATH
```

Requires Node 20+.

---

## Usage

### Command line

Point it at any folder of `.tsx` / `.jsx` / `.ts` files:

```sh
statelint src/                 # pretty output, exit 1 on findings (the CI gate)
statelint src/ --json          # machine-readable findings
statelint src/ --min-drill 3   # tune the prop-drilling threshold
statelint src/ --no-color      # plain text (also honors NO_COLOR / pipes)
```

Example output:

```
src/App.tsx
  3:7  ▲ warn  prop-drilling
        Prop 'orders' drills through 2 components that never read it (Shell → Main) before reaching OrderList.
        → Move this state to Context or a store, or restructure with composition.
  4:8  ▲ warn  server-state-in-client-state
        'orders' holds server data (fetched in an effect) but lives in useState — a hand-rolled cache
        with no dedup, refetch, or staleness handling.
        → Move to TanStack Query (or RTK Query in Redux apps).

▲ 2 problems (2 warnings)
  1 files scanned in 0.1s
```

### Interactive console (`--ui`)

For the develop-and-recheck loop, serve the findings console locally:

```sh
statelint --ui src/            # → statelint console → http://localhost:8734
statelint --ui --port 3030 src/
```

Open the URL. You get the terminal output, severity columns (High / Medium / Low,
collapsible), and full instructions in one page. Edit your code, click **⟳ Rescan** —
the page reloads and the server re-runs the full analysis in-process (~1s on a
mid-size app). No file juggling, no re-running the CLI. Click any file path to open it
in VS Code at the exact line. Ctrl+C stops the server. Nothing leaves your machine —
it binds `127.0.0.1` only.

### In CI

statelint exits `1` on any Medium/High finding, so it gates a pipeline as-is:

```yaml
# .github/workflows/ci.yml
- run: npx statelint src/
```

Advisory (Low) findings exit `0` and won't fail the build.

---

## Flags

| Flag            | Effect                                                          |
| --------------- | --------------------------------------------------------------- |
| `--ui`          | serve the findings console locally (one-click rescan)           |
| `--port N`      | console port (default `8734`)                                   |
| `--min-drill N` | prop-drilling threshold — blind intermediate hops (default `2`) |
| `--json`        | machine-readable output                                         |
| `--no-color`    | disable colored output (also honors `NO_COLOR` and pipes)       |
| `-h`, `--help`  | show help                                                       |

## Exit codes

| Code | Meaning                                        |
| ---- | ---------------------------------------------- |
| `0`  | clean, or only Low (advisory) findings         |
| `1`  | Medium/High findings — **fails CI on purpose** |
| `2`  | usage error (bad flag, no files found)         |

Severity map: **High** = error · **Medium** = warn · **Low** = info.

Test files (`*.test.*`, `*.spec.*`, `*.stories.*`, `__tests__/`, `__mocks__/`) are
skipped automatically — architecture rules describe the app, not its tests.

---

## The rules

| Rule                           | Fires when                                                                                               | Recommends                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `multiple-sources-of-truth`    | one entity owned by 2+ global sources (store / context / storage / URL / cookie), or server-cached twice | Consolidate on one owner               |
| `server-state-in-client-state` | `useState` fed by fetch/await/axios in `useEffect`, grouped per effect; prefilled drafts soften to Low   | TanStack / RTK Query                   |
| `derived-state-as-state`       | `useState` recomputed from other state/props by a synchronous effect                                     | `useMemo` — delete the state + effect  |
| `storage-as-state`             | a localStorage/sessionStorage key read+written across 2+ components (non-reactive)                       | own it in one store with `persist`     |
| `cookie-as-state`              | a cookie shared across components via js-cookie / react-cookie / `document.cookie`                       | one reactive owner; persist from there |
| `url-state-forked`             | a `useState` copy of a URL search param that goes stale on back/forward                                  | read the param directly                |
| `prop-drilling`                | a prop passes through N components that never read it (cross-file, blind hops named)                     | Context, store, or composition         |
| `over-globalized-state`        | a global store/context/slice with exactly one real consumer; dead provided contexts                      | colocate / delete                      |
| `over-broad-selector`          | bare `useStore()` or identity selector on a zustand store                                                | narrow the selector                    |
| `defeated-memo`                | `React.memo` receiving inline object/array/function props — the memo never holds                         | stabilize the props, or drop the memo  |
| `pointless-memo`               | `useMemo`/`useCallback` with no deps array, or an inline literal in the deps                             | fix the deps, or compute inline        |

---

## What it understands

Ten state surfaces plus memoization, modeled as one graph:

- **Local** — `useState` / `useReducer`, with reads/writes/declares tracking
- **Context** — `createContext`, `<Ctx.Provider>` + React 19 `<Ctx value>`, `useContext`/`use`, **and consumption through custom hooks** (`useLock()` wrapping `useContext` attributes to callers, transitively)
- **Zustand** — `create()` + curried `create<T>()()`, selector vs whole-store reads, `setState` writes
- **Redux/RTK** — `createSlice` (identity = slice name), `useSelector`/`useAppSelector` state-path resolution
- **RTK Query** — `createApi` query endpoints, generated `useGetXQuery` hooks
- **TanStack Query** — v5 object + v4 positional forms, **identity = query key** (call sites sharing a key share one source, like the real cache)
- **Web storage** — `localStorage` / `sessionStorage`, `window.`/`globalThis.` forms, keyed by storage key
- **Cookies** — js-cookie, react-cookie's `useCookies`, raw `document.cookie` (reactive vs non-reactive access distinguished)
- **URL** — `useSearchParams`, route params, nuqs; forked-copy detection
- **Memoization** — `React.memo`, `useMemo`, `useCallback` structural breakage
- **Cross-file** — everything resolves through default/named/aliased imports and `index.*` re-exports; same-named locals in different files never collide

Recommendations are **stack-aware**: statelint reads which tools your app leans on and
names the dominant one, so it won't tell a lightly-Redux app to reach for RTK Query.

---

## Design rules (the trust contract)

1. **Detectors are pure graph queries.** All AST work happens once, in the graph
   builder; detectors read `sources`/`edges` only.
2. **Never guess.** Generic entity names (`data`, `state`, `error`) are suppressed, not
   matched. Dynamic query/storage keys get no source. Unclassifiable state is `unknown`
   and never auto-recommended on.
3. **Silence beats lying.** Single-owner storage, accumulator setters, event-driven
   effects, and updater-form `set(prev => …)` are all excluded. A finding you can't
   trust is worse than no finding.

## Status

Early but real: 130 tests, dogfooded on a production PWA and a 409-file production
Redux app — where several false positives were found and each became a permanent guard
and regression test. Not yet published to npm.

Docs: [positioning brief](docs/positioning.md) · [detector map](docs/detector-map.md)

## Anti-goals

- ❌ Not a re-render visualizer (React Scan)
- ❌ Not a single-session in-browser profiler (React DevTools)
- ❌ Not per-library inspection (Redux/Zustand/Query devtools)
- ❌ Not file-scoped lint rules (ESLint)

Runtime data (the React Fiber hook) is a planned _enrichment_ layer for ranking
findings by real impact — never the architecture.
