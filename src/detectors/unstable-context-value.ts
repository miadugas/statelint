/**
 * Unstable context value — a Context provider handed an inline object/array/
 * function literal as `value`. Context skips the memo game: it compares the
 * value by reference and re-renders EVERY consumer whenever it changes. An
 * inline literal is a new reference every render, so every consumer re-renders
 * on every provider render — even when the data underneath never moved. Static
 * analysis can prove the reference is fresh; it can't prove the render is slow,
 * so that's all this claims. Provide/inject (Vue) is gated out by kind.
 */

import type { StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export function detectUnstableContextValue(graph: StateGraph): Finding[] {
  const findings: Finding[] = [];

  for (const edge of graph.edges) {
    if (edge.type !== "provides" || !edge.inline) continue;

    const source = graph.sources.get(edge.to);
    // provide/inject also emits `provides` edges — the kind gate keeps this
    // React-only. Vue's provide() never carries the inline flag anyway.
    if (source?.kind !== "context") continue;

    const consumers = graph.edges.filter(
      (e) => e.type === "consumes" && e.to === source.id,
    ).length;
    // A provider nobody consumes is dead-context territory (over-globalized-
    // state), not a re-render problem — no consumers, no defeated renders.
    if (consumers < 1) continue;

    const providerName = graph.components.get(edge.from)?.name ?? edge.from;

    findings.push({
      rule: "unstable-context-value",
      severity: "warn",
      message: `${providerName} provides ${source.name} with an inline object/array/function value — a new reference every render, so all ${consumers} consumer(s) seen re-render on every render of ${providerName}, even when the data is unchanged.`,
      recommendation: `Stabilize the value: useMemo the object with its real deps, useCallback a function value, or hoist a never-changing value to module scope. Context has no reference-equality bail-out — an unstable value re-renders every consumer.`,
      loc: edge.loc ?? source.loc,
      path: [edge.from],
    });
  }

  return findings;
}
