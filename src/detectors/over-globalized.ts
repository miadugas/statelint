/**
 * Over-globalized state — a context provided in the tree but consumed by
 * one component (colocate instead) or none at all (dead weight).
 * Pure query over provides/consumes edges.
 */

import type { StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export function detectOverGlobalizedState(graph: StateGraph): Finding[] {
  const findings: Finding[] = [];

  for (const source of graph.sources.values()) {
    if (source.kind !== "context") continue;

    const provided = graph.edges.some(
      (e) => e.type === "provides" && e.to === source.id,
    );
    if (!provided) continue; // declared but never mounted — likely lib/test code, stay quiet

    const consumers = graph.edges.filter(
      (e) => e.type === "consumes" && e.to === source.id,
    );

    if (consumers.length === 1) {
      const consumer = consumers[0]!;
      const consumerName =
        graph.components.get(consumer.from)?.name ?? consumer.from;
      findings.push({
        rule: "over-globalized-state",
        severity: "warn",
        message: `Context '${source.name}' is provided app-wide but consumed by exactly one component (${consumerName}).`,
        recommendation: `Colocate: move this state into ${consumerName} (or its parent) and delete the context.`,
        loc: source.loc,
        path: [consumer.from],
      });
    } else if (consumers.length === 0) {
      findings.push({
        rule: "over-globalized-state",
        severity: "info",
        message: `Context '${source.name}' is provided but never consumed — dead weight in the tree.`,
        recommendation:
          "Delete the context and its provider, or wire up the intended consumers.",
        loc: source.loc,
      });
    }
  }

  return findings;
}
