# statelinter — Detector Map

**Static engine** runs headless in CI + editor (the lane's core). **Runtime layer** is
React Fiber-hook enrichment that ranks findings by real impact — never detects
architecture on its own.

Covered surface: **Context · Redux/RTK · RTK Query · Zustand · TanStack Query · local ·
storage · cookies · URL · ref/reactive/computed · Pinia · Vuex · provide/inject ·
vue-query/Nuxt**.
Status: ✅ shipped · 🔜 planned.

## Static — Placement / source-of-truth (the wedge)

| Status | Detector                     | Library                                                                                                                                         | Recommendation                                                                       |
| ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ✅     | Server-state-in-client-state | `useState`/`ref`/`reactive` (Options API `data()` too), fed by fetch/await in an effect or lifecycle hook                                       | → TanStack Query (React) / @tanstack/vue-query or Nuxt's useAsyncData/useFetch (Vue) |
| ✅     | Multiple sources of truth    | cross-library — competing global owners (context/zustand/redux-slice/pinia/vuex/provide-inject/storage/URL/cookie) AND duplicated server caches | Consolidate to one owner                                                             |
| ✅     | Over-globalized state        | Context / Zustand / Redux slices / Pinia / Vuex / provide-inject — single consumer or dead context/provided value                               | Colocate / delete                                                                    |
| ✅     | Storage-as-state             | `localStorage`/`sessionStorage` key read+written across 2+ components (non-reactive)                                                            | Own it in one store with `persist`                                                   |
| ✅     | Cookie-as-state              | js-cookie, react-cookie's `useCookies`, raw `document.cookie`                                                                                   | One reactive owner; persist from there                                               |
| 🔜     | Server state in Redux slices | Redux/RTK (manual thunk caches)                                                                                                                 | → RTK Query                                                                          |
| 🔜     | Wrong-tool placement         | all                                                                                                                                             | Move per classification                                                              |
| 🔜     | Should-be-lifted state       | local                                                                                                                                           | Lift to common parent                                                                |

## Static — Flow / structure

| Status | Detector                  | Library                                                                                                      | Recommendation                                                       |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| ✅     | Prop drilling             | — (cross-file JSX props AND Vue template `:prop` binds, names blind intermediates)                           | → Context/store (React) or composition — slots (Vue)                 |
| ✅     | Over-broad selector       | Zustand (bare `useStore()` / identity selector) — React only                                                 | Narrow selector                                                      |
| ✅     | Derived-state-as-state    | `useState`/`ref`/`reactive`/Options API `data()` recomputed from other state by a synchronous effect/watcher | → `useMemo` (React) / `computed()` (Vue) — delete the state + effect |
| ✅     | URL-state-forked          | `useState` copy of a URL search param that goes stale on back/forward — React only (`useSearchParams`, nuqs) | Read the param directly                                              |
| 🔜     | Over-broad selector       | Redux `useSelector` whole-state reads                                                                        | Narrow selector                                                      |
| 🔜     | Derived data in store     | Redux/RTK                                                                                                    | → `createSelector`                                                   |
| 🔜     | Forked / duplicated state | all (needs initialization analysis)                                                                          | Remove copy, read source                                             |
| 🔜     | Over-broad Context value  | Context                                                                                                      | Split / add selector                                                 |
| 🔜     | Unmemoized `useSelector`  | Redux                                                                                                        | Memoize / narrow                                                     |
| 🔜     | vue-router URL state      | vue-router — `useRoute().query` isn't tracked                                                                | (not modeled yet)                                                    |

## Static — Memoization (React only)

| Status | Detector                                                                     | Recommendation                        |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------- |
| ✅     | Defeated `React.memo` (inline object/array/function props)                   | Stabilize the props, or drop the memo |
| ✅     | Pointless `useMemo`/`useCallback` (no deps array, or inline literal in deps) | Fix the deps, or compute inline       |

## Runtime — Impact / ranking (Fiber hook) — all planned

| Detector                            | Use                             |
| ----------------------------------- | ------------------------------- |
| Wasted memo                         | Confirms static memo findings   |
| Too many re-renders                 | Severity rank                   |
| Large / non-serializable store blob | Severity rank                   |
| Unstable-ref render storms          | Promotes static "risk" → "real" |

## The split is the point

Architecture findings (the static detectors) never depend on running the app — which
is exactly what makes statelinter continuous and team-enforceable. Runtime tells you
_severity_, static finds _structure_.
