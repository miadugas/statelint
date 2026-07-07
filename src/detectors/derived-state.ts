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
    if (source.kind !== "useState" && source.kind !== "useReducer") continue;
    if (!source.derivedSync || source.derivedSync.editedOutsideEffect) continue;

    findings.push({
      rule: "derived-state-as-state",
      severity: "warn",
      message: `'${source.name}' is recomputed from other state/props by a synchronous effect — it's a pure function of existing data, stored as state. Every change renders twice, once with '${source.name}' stale.`,
      recommendation: `Compute it during render: const ${source.name} = useMemo(() => …, [deps]) — or inline it if cheap. Delete the useState and the useEffect.`,
      loc: source.derivedSync.effect,
      path: source.ownerComponentId ? [source.ownerComponentId] : undefined,
    });
  }

  return findings;
}
