/**
 * runStatelinter — the engine entry: files in, sorted findings out.
 * The CLI is a thin I/O shell around this so the core stays testable.
 */

import type { SourceFileInput } from "./graph/build.js";
import { buildStateGraph } from "./graph/build.js";
import type { BuildOptions } from "./graph/build.js";
import { detectCookieAsState } from "./detectors/cookie-as-state.js";
import { detectDefeatedMemo } from "./detectors/defeated-memo.js";
import { detectDerivedStateAsState } from "./detectors/derived-state.js";
import { detectMultipleSourcesOfTruth } from "./detectors/multiple-sources.js";
import { detectOverBroadSelector } from "./detectors/over-broad-selector.js";
import { detectOverGlobalizedState } from "./detectors/over-globalized.js";
import { detectPointlessMemo } from "./detectors/pointless-memo.js";
import { detectPropDrilling } from "./detectors/prop-drilling.js";
import { detectServerStateInClientState } from "./detectors/server-state.js";
import { computeStackProfile } from "./detectors/stack.js";
import { detectStorageAsState } from "./detectors/storage-as-state.js";
import { detectUrlStateForked } from "./detectors/url-fork.js";
import type { Finding } from "./detectors/types.js";
import type { StateGraph, StateKind } from "./graph/schema.js";

export interface RunOptions {
  /** Prop-drilling threshold; see PropDrillingOptions. */
  minBlindIntermediates?: number;
  /** Forwarded to buildStateGraph — skip unparseable files instead of throwing. */
  onParseError?: BuildOptions["onParseError"];
  /** Called once after the graph is built, with build-time metadata (e.g.
   * unmodeled Vue Options API components, and which frameworks the scanned
   * files use) the CLI may want to surface. */
  onMeta?: (meta: {
    optionsComponents: number;
    stack: { react: boolean; vue: boolean; nuxt: boolean };
  }) => void;
}

// Kinds that only exist on the Vue side of the graph (see graph/schema.ts).
const VUE_KINDS = new Set<StateKind>([
  "ref",
  "reactive",
  "computed",
  "pinia",
  "provide-inject",
  "vuex",
  "options-data",
]);
// Kinds that only exist on the React side. `tanstack-query` is deliberately
// excluded — @tanstack/vue-query registers sources under the same
// "tanstack-query" kind (see graph/vue.test.ts), so it can't disambiguate.
const REACT_KINDS = new Set<StateKind>([
  "useState",
  "useReducer",
  "context",
  "zustand",
  "redux-slice",
  "rtk-query",
]);

/** Cheap, single-pass stack detection: component file extensions plus each
 * source's kind (both signals are framework-exclusive except tanstack-query,
 * which both React and Vue Query register under the same kind — see above). */
function detectStack(
  graph: StateGraph,
  nuxt: boolean,
): { react: boolean; vue: boolean; nuxt: boolean } {
  let react = false;
  let vue = false;
  for (const id of graph.components.keys()) {
    const file = id.slice(0, id.lastIndexOf("#"));
    if (file.endsWith(".vue")) vue = true;
    else if (file.endsWith(".tsx") || file.endsWith(".jsx")) react = true;
  }
  for (const source of graph.sources.values()) {
    if (VUE_KINDS.has(source.kind)) vue = true;
    else if (REACT_KINDS.has(source.kind)) react = true;
  }
  return { react, vue, nuxt };
}

export function runStatelinter(
  files: SourceFileInput[],
  options: RunOptions = {},
): Finding[] {
  const graph = buildStateGraph(files, { onParseError: options.onParseError });
  // Recommendations follow the app's dominant tools, measured once per run.
  const profile = computeStackProfile(graph);
  options.onMeta?.({
    optionsComponents: graph.unresolved.optionsComponents,
    stack: detectStack(graph, profile.nuxt),
  });
  const findings = [
    ...detectMultipleSourcesOfTruth(graph, profile),
    ...detectServerStateInClientState(graph, profile),
    ...detectOverGlobalizedState(graph),
    ...detectOverBroadSelector(graph),
    ...detectStorageAsState(graph, profile),
    ...detectCookieAsState(graph),
    ...detectUrlStateForked(graph),
    ...detectDerivedStateAsState(graph),
    ...detectDefeatedMemo(graph),
    ...detectPointlessMemo(graph),
    ...detectPropDrilling(graph, {
      minBlindIntermediates: options.minBlindIntermediates,
    }),
  ];
  return findings.sort(
    (a, b) => a.loc.file.localeCompare(b.loc.file) || a.loc.line - b.loc.line,
  );
}
