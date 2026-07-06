/**
 * Over-broad selector — a component subscribes to an entire zustand store
 * (bare `useStore()` or the identity selector `(s) => s`), so it re-renders
 * on every store change regardless of which fields it uses.
 */

import type { StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export function detectOverBroadSelector(graph: StateGraph): Finding[] {
  const findings: Finding[] = [];

  for (const source of graph.sources.values()) {
    if (source.kind !== "zustand") continue;

    // reads via 'hook' = whole-store subscription; via 'selector' = narrowed.
    const wholeStoreReads = graph.edges.filter(
      (e) => e.type === "reads" && e.to === source.id && e.via === "hook",
    );

    for (const read of wholeStoreReads) {
      const componentName = graph.components.get(read.from)?.name ?? read.from;
      const fieldHint =
        source.shape?.fields && source.shape.fields.length > 0
          ? `(s) => s.${source.shape.fields[0]}`
          : "(s) => s.someField";
      findings.push({
        rule: "over-broad-selector",
        severity: "warn",
        message: `${componentName} subscribes to the entire '${source.name}' store — it re-renders on every store change.`,
        recommendation: `Select only what it uses: ${source.name}(${fieldHint}).`,
        loc: graph.components.get(read.from)?.loc ?? source.loc,
        path: [read.from],
      });
    }
  }

  return findings;
}
