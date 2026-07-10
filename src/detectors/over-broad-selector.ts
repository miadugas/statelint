/**
 * Over-broad selector — two structurally-different whole-store subscriptions:
 *
 * 1. Zustand: a component binds an entire store (bare `useStore()` or the
 *    identity selector `(s) => s`), so it re-renders on every store change
 *    regardless of which fields it uses.
 * 2. Pinia: a component-scope `store.$subscribe(cb)` — the callback runs on
 *    every mutation of every field. (Plain pinia `reads:hook` binds are NOT
 *    flagged: pinia stores are per-property-tracked proxies, so a whole-store
 *    bind is benign — see issue #1. Only the `subscribe` edge is a hazard.)
 *
 * Same rule, same severity; the message/recommendation is phrased per library.
 */

import type { StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export function detectOverBroadSelector(graph: StateGraph): Finding[] {
  const findings: Finding[] = [];

  for (const source of graph.sources.values()) {
    // ── Zustand: whole-store binds (via 'hook'); via 'selector' = narrowed. ──
    if (source.kind === "zustand") {
      const wholeStoreReads = graph.edges.filter(
        (e) => e.type === "reads" && e.to === source.id && e.via === "hook",
      );

      for (const read of wholeStoreReads) {
        const componentName =
          graph.components.get(read.from)?.name ?? read.from;
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
      continue;
    }

    // ── Pinia: component-scope `store.$subscribe(cb)` (via 'subscribe'). ──
    if (source.kind === "pinia") {
      const subscribeReads = graph.edges.filter(
        (e) =>
          e.type === "reads" && e.to === source.id && e.via === "subscribe",
      );

      for (const read of subscribeReads) {
        const componentName =
          graph.components.get(read.from)?.name ?? read.from;
        // Only name a concrete field when the store's shape proves one exists;
        // otherwise hedge to a placeholder rather than assert a field name.
        const fieldHint =
          source.shape?.fields && source.shape.fields.length > 0
            ? source.shape.fields[0]
            : "someField";
        findings.push({
          rule: "over-broad-selector",
          severity: "warn",
          message: `${componentName} subscribes to the WHOLE '${source.name}' store — the callback runs on every mutation of every field.`,
          recommendation: `Narrow to watch(() => store.${fieldHint}, …) for the specific fields it needs; or if the callback persists state, use pinia-plugin-persistedstate instead.`,
          loc: graph.components.get(read.from)?.loc ?? source.loc,
          path: [read.from],
        });
      }
    }
  }

  return findings;
}
