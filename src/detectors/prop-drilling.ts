/**
 * Prop drilling — a prop passes through components that never read it,
 * only forward it. Pure query over passesProp edges; no AST access.
 */

import type {
  ComponentId,
  Edge,
  StateClass,
  StateGraph,
} from "../graph/schema.js";
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

/**
 * The class of state the origin component holds — our honest proxy for where
 * the drilled prop came from. We can't match the exact source (the graph tracks
 * consumption per-component, not per-binding), so we read every source the
 * origin declares/reads/consumes. One agreed class → confident; empty or mixed
 * → "unknown", and we refuse to prescribe a home. */
function originClass(graph: StateGraph, origin: ComponentId): StateClass {
  const classes = new Set<StateClass>();
  for (const e of graph.edges) {
    if (e.from !== origin) continue;
    if (e.type !== "declares" && e.type !== "reads" && e.type !== "consumes")
      continue;
    const cls = graph.sources.get(e.to)?.classification;
    if (cls && cls !== "unknown") classes.add(cls);
  }
  return classes.size === 1 ? [...classes][0]! : "unknown";
}

/**
 * The fix depends entirely on where the state lives — so the rec is keyed on
 * the origin class, and hedges (never prescribes a home) when it's unknown.
 */
function recommend(
  cls: StateClass,
  prop: string,
  leaf: string,
  blindNames: string,
  vue: boolean,
): string {
  // Composition is the local-state fix in both frameworks — children in
  // React, slots in Vue — so that wording keys on the origin's framework.
  const compose = vue
    ? `Pass the content through a slot instead of threading '${prop}' through ${blindNames}`
    : `Pass the element as a child instead of threading '${prop}' through ${blindNames}`;
  switch (cls) {
    case "global-client":
      return `'${prop}' is already shared state — read it directly in ${leaf} and drop the prop from ${blindNames}.`;
    case "server-cache":
      return `Call the ${vue ? "data/query composable" : "query hook"} directly in ${leaf} — it's cached, so it won't refetch — and drop the prop from ${blindNames}.`;
    case "derived":
      return `Derive '${prop}' in ${leaf} instead of threading it through ${blindNames}.`;
    case "local":
      return `${compose}, or lift to a store if many components need it.`;
    default:
      return `Trace where '${prop}' comes from: if it's already shared state, read it in ${leaf}; if it's local, ${vue ? "pass the content through a slot" : "pass the element as a child"} instead of threading it through ${blindNames}.`;
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

  // Local state genuinely stranded in a subtree is the only case worth a warn;
  // an already-shared prop is a cleanup, not a defect.
  const cls = originClass(graph, first.from);
  const severity = cls === "local" ? "warn" : "info";
  const vue = originLoc.file.endsWith(".vue");

  findings.push({
    rule: "prop-drilling",
    severity,
    message: `Prop '${first.prop}' drills through ${blind.length} component${
      blind.length === 1 ? "" : "s"
    } that only forward it (${blindNames}) before reaching ${name(last.to)}.`,
    recommendation: recommend(cls, first.prop, name(last.to), blindNames, vue),
    loc: originLoc,
    path: [first.from, ...path.map((e) => e.to)],
  });
}
