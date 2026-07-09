/**
 * Derived-state-as-state — a useState recomputed from other state/props by a
 * synchronous effect. State that is a pure function of other state shouldn't
 * be state at all: it renders twice (once stale), and the effect is a manual,
 * lagging cache of something the render could compute.
 *
 * Guards: setter must be called directly in the effect body (timer and
 * subscription callbacks don't count), never called anywhere else, and
 * async-fed state belongs to server-state-in-client-state instead.
 */

import type { StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export function detectDerivedStateAsState(graph: StateGraph): Finding[] {
  const findings: Finding[] = [];

  for (const source of graph.sources.values()) {
    if (
      source.kind !== "useState" &&
      source.kind !== "useReducer" &&
      source.kind !== "ref" &&
      source.kind !== "options-data"
    )
      continue;
    if (!source.derivedSync || source.derivedSync.editedOutsideEffect) continue;

    // The fix is framework-specific, so it keys on the source kind.
    const options = source.kind === "options-data";
    const vue = source.kind === "ref" || options;
    findings.push({
      rule: "derived-state-as-state",
      severity: "warn",
      message: `'${source.name}' is recomputed from other state/props by a synchronous ${
        vue ? "watcher" : "effect"
      } — it's a pure function of existing data, stored as state. Every change renders twice, once with '${source.name}' stale.`,
      recommendation: options
        ? `Make it a computed: add ${source.name}() to the computed option — delete the data field and the watch handler.`
        : vue
          ? `Make it computed: const ${source.name} = computed(() => …) — delete the ref and the watcher.`
          : `Compute it during render: const ${source.name} = useMemo(() => …, [deps]) — or inline it if cheap. Delete the useState and the useEffect.`,
      loc: source.derivedSync.effect,
      path: source.ownerComponentId ? [source.ownerComponentId] : undefined,
    });
  }

  return findings;
}
