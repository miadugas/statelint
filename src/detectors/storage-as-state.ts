/**
 * Storage-as-state — a localStorage/sessionStorage key read AND written
 * across multiple components is being used as a de-facto global store.
 * Storage isn't reactive: writers don't re-render readers, so every one of
 * these is a stale-UI bug waiting for a second tab or a missed refresh.
 *
 * Single-component persistence (one owner reading and writing its own key)
 * is a legitimate pattern and stays quiet.
 */

import type { StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export function detectStorageAsState(graph: StateGraph): Finding[] {
  const findings: Finding[] = [];

  for (const source of graph.sources.values()) {
    if (source.kind !== "local-storage" && source.kind !== "session-storage")
      continue;

    const readers = new Set<string>();
    const writers = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.to !== source.id) continue;
      if (edge.type === "reads") readers.add(edge.from);
      if (edge.type === "writes") writers.add(edge.from);
    }

    const touchers = new Set([...readers, ...writers]);
    if (touchers.size < 2 || writers.size === 0) continue;

    const label =
      source.kind === "local-storage" ? "localStorage" : "sessionStorage";
    const names = [...touchers]
      .map((id) => graph.components.get(id)?.name ?? id)
      .sort();
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? ` +${names.length - 3} more` : "";

    findings.push({
      rule: "storage-as-state",
      severity: "warn",
      message: `${label} key '${source.name}' is used as a shared store by ${touchers.size} components (${shown}${more}) — storage isn't reactive, so writes never re-render readers.`,
      recommendation: `Own '${source.name}' in one reactive store and persist it from there (e.g. zustand persist middleware); components read state, not storage.`,
      loc: source.loc,
      path: names,
    });
  }

  return findings;
}
