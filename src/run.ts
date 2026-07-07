/**
 * runStatelint — the engine entry: files in, sorted findings out.
 * The CLI is a thin I/O shell around this so the core stays testable.
 */

import type { SourceFileInput } from "./graph/build.js";
import { buildStateGraph } from "./graph/build.js";
import type { BuildOptions } from "./graph/build.js";
import { detectMultipleSourcesOfTruth } from "./detectors/multiple-sources.js";
import { detectOverBroadSelector } from "./detectors/over-broad-selector.js";
import { detectOverGlobalizedState } from "./detectors/over-globalized.js";
import { detectPropDrilling } from "./detectors/prop-drilling.js";
import { detectServerStateInClientState } from "./detectors/server-state.js";
import { computeStackProfile } from "./detectors/stack.js";
import { detectStorageAsState } from "./detectors/storage-as-state.js";
import { detectUrlStateForked } from "./detectors/url-fork.js";
import type { Finding } from "./detectors/types.js";

export interface RunOptions {
  /** Prop-drilling threshold; see PropDrillingOptions. */
  minBlindIntermediates?: number;
  /** Forwarded to buildStateGraph — skip unparseable files instead of throwing. */
  onParseError?: BuildOptions["onParseError"];
}

export function runStatelint(
  files: SourceFileInput[],
  options: RunOptions = {},
): Finding[] {
  const graph = buildStateGraph(files, { onParseError: options.onParseError });
  // Recommendations follow the app's dominant tools, measured once per run.
  const profile = computeStackProfile(graph);
  const findings = [
    ...detectMultipleSourcesOfTruth(graph, profile),
    ...detectServerStateInClientState(graph, profile),
    ...detectOverGlobalizedState(graph),
    ...detectOverBroadSelector(graph),
    ...detectStorageAsState(graph, profile),
    ...detectUrlStateForked(graph),
    ...detectPropDrilling(graph, {
      minBlindIntermediates: options.minBlindIntermediates,
    }),
  ];
  return findings.sort(
    (a, b) => a.loc.file.localeCompare(b.loc.file) || a.loc.line - b.loc.line,
  );
}
