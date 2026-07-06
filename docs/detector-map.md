# statelint — Detector Map

**Static engine** runs headless in CI + editor (the lane's core). **Runtime layer** is
React Fiber-hook enrichment that ranks findings by real impact — never detects
architecture on its own.

Covered surface: **Context · Redux/RTK · RTK Query · Zustand · TanStack Query · local**.
13 static + 4 runtime.

## Static — Placement / source-of-truth (the wedge)

| Detector                     | Library                                           | Recommendation                            |
| ---------------------------- | ------------------------------------------------- | ----------------------------------------- |
| Server-state-in-client-state | local                                             | → TanStack Query                          |
| Server state in Redux        | Redux/RTK                                         | → RTK Query                               |
| Multiple sources of truth    | cross-library (Redux + Context + Zustand + local) | Consolidate to one owner                  |
| Wrong-tool placement         | all                                               | Move per classification                   |
| Over-globalized state        | Redux / Zustand / Context                         | Colocate (local UI in Redux → `useState`) |
| Should-be-lifted state       | local                                             | Lift to common parent                     |

## Static — Flow / structure

| Detector                  | Library                       | Recommendation           |
| ------------------------- | ----------------------------- | ------------------------ |
| Prop drilling             | —                             | → Context or store       |
| Derived-state-as-state    | local                         | → `useMemo` / derive     |
| Derived data in store     | Redux/RTK                     | → `createSelector`       |
| Forked / duplicated state | all                           | Remove copy, read source |
| Over-broad Context value  | Context                       | Split / add selector     |
| Over-broad selector       | Zustand + Redux `useSelector` | Narrow selector          |
| Unmemoized `useSelector`  | Redux                         | Memoize / narrow         |

## Static — Memoization

| Detector                                 | Recommendation             |
| ---------------------------------------- | -------------------------- |
| Defeated `React.memo` (inline ref props) | Stabilize refs / drop memo |
| Pointless `useMemo` / `useCallback`      | Remove                     |

## Runtime — Impact / ranking (Fiber hook)

| Detector                            | Use                             |
| ----------------------------------- | ------------------------------- |
| Wasted memo                         | Confirms static memo findings   |
| Too many re-renders                 | Severity rank                   |
| Large / non-serializable store blob | Severity rank                   |
| Unstable-ref render storms          | Promotes static "risk" → "real" |

## The split is the point

Architecture findings (the 13 static detectors) never depend on running the app — which
is exactly what makes statelint continuous and team-enforceable. Runtime tells you
_severity_, static finds _structure_.
