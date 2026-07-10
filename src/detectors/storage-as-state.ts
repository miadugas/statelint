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
import type { StackProfile } from "./stack.js";
import { NEUTRAL_PROFILE } from "./stack.js";

export function detectStorageAsState(
  graph: StateGraph,
  profile: StackProfile = NEUTRAL_PROFILE,
): Finding[] {
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

    // Compatibility gate: the profile's persistHint names the graph-wide
    // dominant store, which can belong to the other framework in a mixed
    // repo. If every participating component is one framework and the hinted
    // store belongs to the other, drop to the neutral hint. Component ids are
    // `file#Name`; pinia/vuex → vue, zustand/redux-slice → react.
    const files = [...touchers].map((id) => id.slice(0, id.lastIndexOf("#")));
    const componentFramework = files.every((f) => f.endsWith(".vue"))
      ? "vue"
      : files.some((f) => f.endsWith(".vue"))
        ? null // mixed — can't attribute a single framework
        : "react";
    const persistFramework =
      profile.persistKind === "pinia" || profile.persistKind === "vuex"
        ? "vue"
        : profile.persistKind === "zustand" ||
            profile.persistKind === "redux-slice"
          ? "react"
          : null;
    const persistHint =
      persistFramework &&
      componentFramework &&
      persistFramework !== componentFramework
        ? NEUTRAL_PROFILE.persistHint
        : profile.persistHint;

    findings.push({
      rule: "storage-as-state",
      severity: "warn",
      message: `${label} key '${source.name}' is used as a shared store by ${touchers.size} components (${shown}${more}) — storage isn't reactive, so writes never re-render readers.`,
      recommendation: `Own '${source.name}' in ${persistHint}; components read state, not storage.`,
      loc: source.loc,
      path: names,
    });
  }

  return findings;
}
