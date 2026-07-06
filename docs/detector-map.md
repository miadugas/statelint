# statelint — Detector Map

**Static engine** runs headless in CI + editor (the lane's core). **Runtime layer** is
React Fiber-hook enrichment that ranks findings by real impact — never detects
architecture on its own.

Covered surface: **Context · Redux/RTK · RTK Query · Zustand · TanStack Query · local**.
Status: ✅ shipped · 🔜 planned.

## Static — Placement / source-of-truth (the wedge)

| Status | Detector                     | Library                                                                                                                              | Recommendation           |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| ✅     | Server-state-in-client-state | local                                                                                                                                | → TanStack Query         |
| ✅     | Multiple sources of truth    | cross-library — competing global owners (context/zustand/redux-slice) AND duplicated server caches (query + hand-rolled fetch state) | Consolidate to one owner |
| ✅     | Over-globalized state        | Context / Zustand / Redux slices — single consumer or dead context                                                                   | Colocate / delete        |
| 🔜     | Server state in Redux slices | Redux/RTK (manual thunk caches)                                                                                                      | → RTK Query              |
| 🔜     | Wrong-tool placement         | all                                                                                                                                  | Move per classification  |
| 🔜     | Should-be-lifted state       | local                                                                                                                                | Lift to common parent    |

## Static — Flow / structure

| Status | Detector                  | Library                                   | Recommendation           |
| ------ | ------------------------- | ----------------------------------------- | ------------------------ |
| ✅     | Prop drilling             | — (cross-file, names blind intermediates) | → Context or store       |
| ✅     | Over-broad selector       | Zustand (bare hook / identity selector)   | Narrow selector          |
| 🔜     | Over-broad selector       | Redux `useSelector` whole-state reads     | Narrow selector          |
| 🔜     | Derived-state-as-state    | local                                     | → `useMemo` / derive     |
| 🔜     | Derived data in store     | Redux/RTK                                 | → `createSelector`       |
| 🔜     | Forked / duplicated state | all (needs initialization analysis)       | Remove copy, read source |
| 🔜     | Over-broad Context value  | Context                                   | Split / add selector     |
| 🔜     | Unmemoized `useSelector`  | Redux                                     | Memoize / narrow         |

## Static — Memoization

| Status | Detector                                 | Recommendation             |
| ------ | ---------------------------------------- | -------------------------- |
| 🔜     | Defeated `React.memo` (inline ref props) | Stabilize refs / drop memo |
| 🔜     | Pointless `useMemo` / `useCallback`      | Remove                     |

## Runtime — Impact / ranking (Fiber hook) — all planned

| Detector                            | Use                             |
| ----------------------------------- | ------------------------------- |
| Wasted memo                         | Confirms static memo findings   |
| Too many re-renders                 | Severity rank                   |
| Large / non-serializable store blob | Severity rank                   |
| Unstable-ref render storms          | Promotes static "risk" → "real" |

## The split is the point

Architecture findings (the static detectors) never depend on running the app — which
is exactly what makes statelint continuous and team-enforceable. Runtime tells you
_severity_, static finds _structure_.
