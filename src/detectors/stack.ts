/**
 * Stack profile — what this app ACTUALLY uses, measured from the graph.
 * Recommendations follow the dominant tool: an app with three RTK slices and
 * heavy TanStack usage should never be told "or RTK Query in Redux apps".
 */

import type { StateGraph, StateKind } from "../graph/schema.js";

export interface StackProfile {
  /** The query library to recommend, by observed usage. Null = app has neither. */
  serverLib: "TanStack Query" | "RTK Query" | null;
  /** The kind behind `serverLib`, so consumers can compatibility-gate: RTK
   * Query is React-only, so a Vue-kind finding must never be pointed at it. */
  serverLibKind: "rtk-query" | "tanstack-query" | null;
  /** How to phrase "persist it from a store" for this app's dominant store. */
  persistHint: string;
  /** The store kind behind `persistHint`, so consumers can compatibility-gate:
   * pinia/vuex belong to Vue, zustand/redux-slice to React. */
  persistKind: "pinia" | "vuex" | "redux-slice" | "zustand" | null;
  /** Nuxt composables observed — recommend useAsyncData/useFetch first. */
  nuxt: boolean;
}

export const NEUTRAL_PROFILE: StackProfile = {
  serverLib: null,
  serverLibKind: null,
  persistHint: "one reactive store with a persist middleware",
  persistKind: null,
  nuxt: false,
};

/** Sources of a kind plus every read/consume edge pointing at them. */
function usageOf(graph: StateGraph, kind: StateKind): number {
  let score = 0;
  for (const source of graph.sources.values()) {
    if (source.kind !== kind) continue;
    score += 1 + graph.readsOf(source.id).length;
  }
  return score;
}

export function computeStackProfile(graph: StateGraph): StackProfile {
  const tanstack = usageOf(graph, "tanstack-query");
  const rtkq = usageOf(graph, "rtk-query");
  const zustand = usageOf(graph, "zustand");
  const redux = usageOf(graph, "redux-slice");
  const pinia = usageOf(graph, "pinia");
  const vuex = usageOf(graph, "vuex");

  const serverLibKind =
    tanstack === 0 && rtkq === 0
      ? null
      : rtkq > tanstack
        ? "rtk-query"
        : "tanstack-query";
  const serverLib =
    serverLibKind === null
      ? null
      : serverLibKind === "rtk-query"
        ? "RTK Query"
        : "TanStack Query";

  const persistKind =
    zustand === 0 && redux === 0 && pinia === 0 && vuex === 0
      ? null
      : pinia >= vuex && pinia >= redux && pinia >= zustand
        ? "pinia"
        : vuex >= redux && vuex >= zustand
          ? "vuex"
          : redux > zustand
            ? "redux-slice"
            : "zustand";

  const persistHint =
    persistKind === null
      ? NEUTRAL_PROFILE.persistHint
      : persistKind === "pinia"
        ? "your pinia store via pinia-plugin-persistedstate"
        : persistKind === "vuex"
          ? "your Vuex store via vuex-persistedstate"
          : persistKind === "redux-slice"
            ? "the Redux store via redux-persist"
            : "your zustand store via its persist middleware";

  return {
    serverLib,
    serverLibKind,
    persistHint,
    persistKind,
    nuxt: graph.frameworkHints.nuxt,
  };
}
