# statelinter

**An architecture linter for React and Vue state — across every state tool, on every PR.**

Every existing tool answers _"what is happening?"_ (this component re-rendered, this
store changed). statelinter answers _"is your state architecture right — and what should
it be?"_ — across Context, Redux/RTK, RTK Query, Zustand, TanStack Query on the React
side; `ref`/`reactive`/`computed`, Pinia, and provide/inject on the Vue 3 side; and the
framework-neutral surfaces every app shares — URL params, web storage, cookies — over
the whole app, continuously in CI.

It's not a profiler. It's a **source-of-truth auditor** that sits _above_ the
per-library devtools: it models every state source in your app as one graph and flags
the placement mistakes that accumulate when several devs touch the same code.

All detection is static — no build step, no browser, no instrumentation. That's what
makes it runnable headless in CI on every PR.

---

## Install

Not on npm yet. Run it straight from the repo:

```sh
git clone https://github.com/miadugas/statelint.git && cd statelint
npm install
npm run build
npm link          # puts `statelinter` on your PATH
```

Requires Node 20+.

---

## Usage

### Command line

Point it at any folder of `.tsx` / `.jsx` / `.ts` / `.js` / `.vue` files:

```sh
statelinter src/                 # pretty output, exit 1 on findings (the CI gate)
statelinter src/ --json          # machine-readable findings
statelinter src/ --min-drill 3   # tune the prop-drilling threshold
statelinter src/ --no-color      # plain text (also honors NO_COLOR / pipes)
```

Example output:

```
src/App.tsx
  3:7  ▲ warn  prop-drilling
        Prop 'orders' drills through 2 components that only forward it (Shell → Main) before
        reaching OrderList.
        → Pass the element as a child instead of threading 'orders' through Shell → Main, or
        lift to a store if many components need it.
  4:8  ▲ warn  server-state-in-client-state
        'orders' holds server data (fetched in an effect) but lives in useState — a hand-rolled cache
        with no dedup, refetch, or staleness handling.
        → Move to a query library — TanStack Query's useQuery replaces the useState + useEffect +
        fetch triple.

▲ 2 problems (2 warnings)
  1 files scanned in 0.1s
```

### Interactive console (`--ui`)

For the develop-and-recheck loop, serve the findings console locally:

```sh
statelinter --ui src/            # → statelinter console → http://localhost:8734
statelinter --ui --port 3030 src/
```

Open the URL. You get the terminal output, severity columns (High / Medium / Low,
collapsible), and full instructions in one page. Edit your code, click **⟳ Rescan** —
the page reloads and the server re-runs the full analysis in-process (~1s on a
mid-size app). No file juggling, no re-running the CLI. Click any file path to open it
in VS Code at the exact line. Ctrl+C stops the server. Nothing leaves your machine —
it binds `127.0.0.1` only.

### In CI

statelinter exits `1` on any Medium/High finding, so it gates a pipeline as-is:

```yaml
# .github/workflows/ci.yml
- run: npx statelinter src/
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

Test, story, and config files (`*.test.*`, `*.spec.*`, `*.stories.*`, `*.config.*`,
`*.setup.*`, `__tests__/`, `__mocks__/`) are skipped automatically — architecture rules
describe the app, not its tests.

---

## The rules

| Rule                           | Fires when                                                                                                                                                | Recommends                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `multiple-sources-of-truth`    | one entity owned by 2+ global sources (context / store — zustand, redux, pinia, vuex / provide-inject / storage / URL / cookie), or server-cached twice   | Consolidate on one owner                                                             |
| `server-state-in-client-state` | `useState`/`ref` fed by fetch/await in an effect or lifecycle hook, grouped per effect; prefilled drafts soften to Low                                    | TanStack / RTK Query, or Nuxt's useAsyncData/useFetch                                |
| `derived-state-as-state`       | `useState`/`ref` recomputed from other state by a synchronous effect/watcher                                                                              | `useMemo`/`computed` — delete the state + effect                                     |
| `storage-as-state`             | a localStorage/sessionStorage key read+written across 2+ components (non-reactive)                                                                        | own it in one store with `persist`                                                   |
| `cookie-as-state`              | a cookie shared across components via js-cookie / react-cookie / `document.cookie`                                                                        | one reactive owner; persist from there                                               |
| `url-state-forked`             | a `useState` copy of a URL search param that goes stale on back/forward                                                                                   | read the param directly                                                              |
| `prop-drilling`                | a JSX prop or Vue template bind passes through N components that only forward it (cross-file, blind hops named)                                           | Context/store, or composition (children / slots)                                     |
| `over-globalized-state`        | a global store (zustand / redux / pinia / vuex) or context/provide-inject with exactly one real consumer; dead provided values                            | colocate / delete                                                                    |
| `over-broad-selector`          | bare `useStore()` or identity selector on a zustand store, or a component-scope `$subscribe` on a whole pinia store (its callback runs on every mutation) | narrow the selector (zustand); `watch` a specific field, or a persist plugin (pinia) |
| `defeated-memo`                | `React.memo` receiving inline object/array/function props — the memo never holds (React only)                                                             | stabilize the props, or drop the memo                                                |
| `pointless-memo`               | `useMemo`/`useCallback` with no deps array, or an inline literal in the deps (React only)                                                                 | fix the deps, or compute inline                                                      |

---

## What it understands

Thirteen state surfaces across React and Vue, plus memoization, modeled as one graph:

- **Local** — React `useState`/`useReducer`, with reads/writes/declares tracking; Vue
  `ref`/`shallowRef`/`reactive` in `<script setup>` and Options API `data()` fields
- **Derived** — Vue `computed` — a pure function of other state, so it's never flagged
  as stored derived state (contrast with the `derived-state-as-state` anti-pattern below)
- **Context** — `createContext`, `<Ctx.Provider>` + React 19 `<Ctx value>`, `useContext`/`use`, **and consumption through custom hooks** (`useLock()` wrapping `useContext` attributes to callers, transitively)
- **Zustand** — `create()` + curried `create<T>()()`, selector vs whole-store reads, `setState` writes
- **Redux/RTK** — `createSlice` (identity = slice name), `useSelector`/`useAppSelector` state-path resolution
- **RTK Query** — `createApi` query endpoints, generated `useGetXQuery` hooks
- **TanStack Query** — v5 object + v4 positional forms, **identity = query key** (call sites sharing a key share one source, like the real cache)
- **Pinia** — `defineStore` (options + setup syntax), `storeToRefs`, `$patch`/direct-mutation writes, map helpers (`mapStores`/`mapState`/`mapGetters`/`mapActions`/`mapWritableState`); store identity = the `defineStore` id string
- **Vuex** — `createStore`/`new Vuex.Store`, root + namespaced `modules`, `this.$store.state`/`.getters` reads, `commit`/`dispatch` writes, map helpers, composition `useStore()`
- **provide/inject** — string-keyed `provide()`/`inject()` pairs
- **Web storage** — `localStorage` / `sessionStorage`, `window.`/`globalThis.` forms, keyed by storage key
- **Cookies** — js-cookie, react-cookie's `useCookies`, raw `document.cookie` (reactive vs non-reactive access distinguished)
- **URL** — `useSearchParams`, route params, nuqs; forked-copy detection (React only — see Known limitations)

Plus, not counted as state surfaces but part of the same graph:

- **Memoization** (React only) — `React.memo`, `useMemo`, `useCallback` structural breakage
- **Nuxt 3** — auto-imports resolved without import statements (with local-shadow guards); Nuxt itself is detected via its own composables (`useAsyncData`/`useFetch`/`definePageMeta`/…), and recommendations switch to those instead of a React query library
- **Vue template analysis** — `:prop` binds build the prop-drilling graph across SFCs (kebab-case tags/props normalized, Nuxt auto-registered components resolved by unique name, ambiguity = refuse to guess); `{{ interpolation }}` and directive expressions count as reads; `v-model` and handler mutations (`@click="x = ..."`) are detected precisely from the template AST
- **Cross-file** — everything resolves through default/named/aliased imports, `index.*` re-exports, and `.vue` SFC boundaries; same-named locals in different files never collide

Recommendations are **stack-aware and framework-aware**: statelinter reads which tools
your app leans on and names the dominant one (won't tell a lightly-Redux app to reach
for RTK Query), and phrases the fix in the origin framework's idiom — slot composition
for Vue prop drilling, `ref()` colocation for an over-globalized Pinia store, `computed()`
for Vue derived state.

---

## Known limitations

Honesty is the product's brand — here's what it doesn't cover yet:

- **Vue Options API is analyzed, including most escape hatches.** `data()`, `computed`,
  `props`, `methods`, lifecycle hooks, `watch`, `provide`/`inject`, the `setup()` option,
  pinia/Vuex map helpers, and local `mixins` (in-file or imported object literals) are
  all modeled. What's still unresolved: `extends`, mixins that resolve to a package
  import or a non-literal (dynamic mixin list), and any export shape statelinter
  doesn't recognize at all. When a scan finds such components, statelinter says so on
  stderr and suppresses pinia/provide-inject/vuex "exactly one reader" findings for
  that run — an undercounted reader is a missed finding, but a false "only one reader"
  claim would be worse.
- **vue-router URL state isn't modeled yet.** `useRoute().query` isn't tracked; the
  React URL adapters (`useSearchParams`, nuqs) are.
- **React class components aren't modeled.** Hooks-era React only.

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

Early but real: 208 tests, dogfooded on a production React PWA, a 409-file production
Redux app, and a 31-SFC production Nuxt 3 site — where several false positives were
found and each became a permanent guard and regression test. Not yet published to npm.

Docs: [positioning brief](docs/positioning.md) · [detector map](docs/detector-map.md)

## Anti-goals

- ❌ Not a re-render visualizer (React Scan)
- ❌ Not a single-session in-browser profiler (React DevTools)
- ❌ Not per-library inspection (Redux/Zustand/Query devtools)
- ❌ Not file-scoped lint rules (ESLint)

Runtime data (the React Fiber hook) is a planned _enrichment_ layer for ranking
findings by real impact — never the architecture.
