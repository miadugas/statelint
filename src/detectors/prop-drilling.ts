/**
 * Prop drilling — a prop passes through components that never read it,
 * only forward it. Pure query over passesProp edges; no AST access.
 */

import type { ComponentId, Edge, StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export interface PropDrillingOptions {
  /** Findings fire at this many forward-only intermediates. Default 2. */
  minBlindIntermediates?: number;
}

type PassEdge = Extract<Edge, { type: "passesProp" }>;

export function detectPropDrilling(
  graph: StateGraph,
  options: PropDrillingOptions = {},
): Finding[] {
  const minBlind = options.minBlindIntermediates ?? 2;
  const passes = graph.edges.filter(
    (e): e is PassEdge => e.type === "passesProp",
  );

  // Who received which prop — origins are passers that never received the prop themselves.
  const receivedProps = new Set(passes.map((e) => `${e.to}|${e.prop}`));
  const origins = passes.filter(
    (e) => !receivedProps.has(`${e.from}|${e.prop}`),
  );

  const findings: Finding[] = [];
  for (const origin of origins) {
    walkChains(origin, passes, [origin], findings, graph, minBlind);
  }
  return findings;
}

/** DFS every maximal chain from an origin edge; emit a finding per qualifying path. */
function walkChains(
  current: PassEdge,
  passes: PassEdge[],
  path: PassEdge[],
  findings: Finding[],
  graph: StateGraph,
  minBlind: number,
): void {
  const next = passes.filter(
    (e) =>
      e.from === current.to && e.prop === current.prop && !path.includes(e),
  );

  if (next.length === 0) {
    emitIfDrilled(path, findings, graph, minBlind);
    return;
  }
  for (const edge of next) {
    walkChains(edge, passes, [...path, edge], findings, graph, minBlind);
  }
}

function emitIfDrilled(
  path: PassEdge[],
  findings: Finding[],
  graph: StateGraph,
  minBlind: number,
): void {
  // Intermediates = every receiver except the final one; blind = received but never read.
  const intermediates = path.slice(0, -1);
  const blind = intermediates.filter((e) => !e.reads);
  if (blind.length < minBlind) return;

  const last = path[path.length - 1];
  const first = path[0];
  if (!last || !first) return;

  const name = (id: ComponentId): string =>
    graph.components.get(id)?.name ?? id;
  const blindNames = blind.map((e) => name(e.to)).join(" → ");
  const originLoc = graph.components.get(first.from)?.loc ?? {
    file: "?",
    line: 0,
    col: 0,
  };

  findings.push({
    rule: "prop-drilling",
    severity: "warn",
    message: `Prop '${first.prop}' drills through ${blind.length} component${
      blind.length === 1 ? "" : "s"
    } that never read it (${blindNames}) before reaching ${name(last.to)}.`,
    recommendation:
      "Move this state to Context or a store, or restructure with composition (pass children instead of data).",
    loc: originLoc,
    path: [first.from, ...path.map((e) => e.to)],
  });
}
