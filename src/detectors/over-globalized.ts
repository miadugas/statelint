/**
 * Over-globalized state — global state (context or zustand store) that only
 * one component actually uses (colocate instead), or a provided context no
 * one consumes (dead weight). Pure query over provides/consumes/reads edges.
 */

import type { StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export function detectOverGlobalizedState(graph: StateGraph): Finding[] {
  const findings: Finding[] = [];

  for (const source of graph.sources.values()) {
    if (source.kind === "context" || source.kind === "provide-inject") {
      const provided = graph.edges.some(
        (e) => e.type === "provides" && e.to === source.id,
      );
      if (!provided) continue; // declared but never mounted — likely lib/test code, stay quiet

      // Distinct components, not edges — one component consuming twice is one consumer.
      const consumers = new Set(
        graph.edges
          .filter((e) => e.type === "consumes" && e.to === source.id)
          .map((e) => e.from),
      );

      const label =
        source.kind === "context"
          ? `Context '${source.name}'`
          : `Provided key '${source.name}'`;
      if (consumers.size === 1) {
        // Options API components (`<script>` without `setup`) aren't modeled,
        // so an inject() in one of them wouldn't show up here — consumer
        // counts are floors, not totals, and an "exactly one" claim would be
        // dishonest. (Mirrors the redux-slice selectorReads guard below.)
        if (
          source.kind === "provide-inject" &&
          graph.unresolved.optionsComponents > 0
        )
          continue;
        const consumer = [...consumers][0]!;
        const consumerName = graph.components.get(consumer)?.name ?? consumer;
        findings.push({
          rule: "over-globalized-state",
          severity: "warn",
          message: `${label} is provided app-wide but consumed by exactly one component (${consumerName}).`,
          recommendation:
            source.kind === "context"
              ? `Colocate: move this state into ${consumerName} (or its parent) and delete the context.`
              : `Colocate: move this state into ${consumerName} (or its parent) and drop the provide/inject pair.`,
          loc: source.loc,
          path: [consumer],
        });
      } else if (consumers.size === 0) {
        findings.push({
          rule: "over-globalized-state",
          severity: "info",
          message: `${label} is provided but never consumed — dead weight in the tree.`,
          recommendation:
            source.kind === "context"
              ? "Delete the context and its provider, or wire up the intended consumers."
              : "Delete the provide() call, or wire up the intended inject() consumers.",
          loc: source.loc,
        });
      }
      continue;
    }

    if (
      source.kind === "zustand" ||
      source.kind === "redux-slice" ||
      source.kind === "pinia" ||
      source.kind === "vuex"
    ) {
      // Redux reads via imported named selectors aren't attributable yet —
      // when any exist, reader counts are floors, not totals, so an
      // "exactly one reader" claim would be dishonest. (Solstice dogfood.)
      if (source.kind === "redux-slice" && graph.unresolved.selectorReads > 0)
        continue;
      // Options API components aren't modeled, so a useXStore() call (or
      // this.$store access) inside one wouldn't show up as a read here —
      // reader counts are floors, not totals, and an "exactly one" claim
      // would be dishonest.
      if (
        (source.kind === "pinia" || source.kind === "vuex") &&
        graph.unresolved.optionsComponents > 0
      )
        continue;

      // Distinct components — a store read via both hook and storeToRefs in
      // one component is still one reader.
      const readers = new Set(
        graph.edges
          .filter((e) => e.type === "reads" && e.to === source.id)
          .map((e) => e.from),
      );
      // Zero readers is NOT flagged: getState()/subscribe() usage outside
      // components isn't tracked yet, so "dead" would be a false-positive risk.
      if (readers.size !== 1) continue;

      const reader = [...readers][0]!;
      const readerName = graph.components.get(reader)?.name ?? reader;
      findings.push({
        rule: "over-globalized-state",
        severity: "warn",
        message: `Store '${source.name}' is global but read by exactly one component (${readerName}).`,
        recommendation:
          source.kind === "pinia"
            ? `Colocate: replace the store with local ref()s inside ${readerName} (or its parent).`
            : source.kind === "vuex"
              ? `Colocate: replace the store with local ref()s or a pinia store inside ${readerName} (or its parent).`
              : `Colocate: replace the store with useState inside ${readerName} (or its parent).`,
        loc: source.loc,
        path: [reader],
      });
    }
  }

  return findings;
}
