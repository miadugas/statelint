/**
 * URL-state-forked — `useState(searchParams.get('tab'))` copies the address
 * bar into component state. The copy goes stale on back/forward and on any
 * navigation that changes the param; the URL is already the source of truth.
 */

import type { StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export function detectUrlStateForked(graph: StateGraph): Finding[] {
  const findings: Finding[] = [];

  for (const edge of graph.edges) {
    if (edge.type !== "derivesFrom") continue;
    const url = graph.sources.get(edge.to);
    if (url?.kind !== "url-param") continue;
    const copy = graph.sources.get(edge.from);
    if (!copy || (copy.kind !== "useState" && copy.kind !== "useReducer"))
      continue;

    findings.push({
      rule: "url-state-forked",
      severity: "warn",
      message: `useState '${copy.name}' is initialized from URL param '${url.name}' — a fork of the address bar. It goes stale on back/forward and never re-syncs on navigation.`,
      recommendation: `The URL already owns '${url.name}': read the param directly and update it by navigating (setSearchParams / router.push, or nuqs's useQueryState for a get+set pair).`,
      loc: copy.loc,
      path: copy.ownerComponentId ? [copy.ownerComponentId] : undefined,
    });
  }

  return findings;
}
