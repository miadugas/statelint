/**
 * Server-state-in-client-state — the wedge detector. A useState/useReducer
 * classified as 'server-cache' (fed by async work in an effect) is a
 * hand-rolled server cache that belongs in a query library.
 */

import type { StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export function detectServerStateInClientState(graph: StateGraph): Finding[] {
  return graph
    .sourcesOf("server-cache")
    .filter(
      (source) => source.kind === "useState" || source.kind === "useReducer",
    )
    .map((source) => ({
      rule: "server-state-in-client-state",
      severity: "warn" as const,
      message: `'${source.name}' holds server data (fetched in an effect) but lives in ${source.kind} — a hand-rolled cache with no dedup, refetch, or staleness handling.`,
      recommendation:
        "Move to TanStack Query (or RTK Query in Redux apps): useQuery replaces the useState + useEffect + fetch triple.",
      loc: source.loc,
      path: source.ownerComponentId ? [source.ownerComponentId] : undefined,
    }));
}
