/**
 * Defeated React.memo — a memoized component receiving inline object/array/
 * function props. memo() compares references; an inline literal is a new
 * reference every render, so the memo NEVER holds. Static analysis can prove
 * a memo is broken — never that it's slow — so that's all this claims.
 */

import type { Edge, StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

type PassEdge = Extract<Edge, { type: "passesProp" }>;

export function detectDefeatedMemo(graph: StateGraph): Finding[] {
  const byTarget = new Map<string, PassEdge[]>();
  for (const edge of graph.edges) {
    if (edge.type !== "passesProp" || !edge.inline) continue;
    if (!graph.components.get(edge.to)?.isMemo) continue;
    const group = byTarget.get(edge.to);
    if (group) group.push(edge);
    else byTarget.set(edge.to, [edge]);
  }

  const findings: Finding[] = [];
  for (const [targetId, passes] of byTarget) {
    const target = graph.components.get(targetId);
    if (!target) continue;
    const props = [...new Set(passes.map((p) => `'${p.prop}'`))];
    const shown = props.slice(0, 3).join(", ");
    const more = props.length > 3 ? ` +${props.length - 3} more` : "";
    const first = passes[0]!;
    const passerName = graph.components.get(first.from)?.name ?? first.from;

    findings.push({
      rule: "defeated-memo",
      severity: "warn",
      message: `React.memo on ${target.name} is defeated: ${passerName} passes inline object/array/function props (${shown}${more}) — a new reference every render, so the memo never skips one.`,
      recommendation: `Stabilize the values at the call site (useMemo/useCallback or hoist them) — or remove the memo(); a memo that never holds is pure comparison overhead.`,
      loc: first.loc ?? target.loc,
      path: [first.from, targetId],
    });
  }

  return findings;
}
