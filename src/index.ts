export { buildStateGraph } from "./graph/build.js";
export type { SourceFileInput } from "./graph/build.js";
export { detectPropDrilling } from "./detectors/prop-drilling.js";
export type { PropDrillingOptions } from "./detectors/prop-drilling.js";
export { detectServerStateInClientState } from "./detectors/server-state.js";
export { detectOverGlobalizedState } from "./detectors/over-globalized.js";
export { detectOverBroadSelector } from "./detectors/over-broad-selector.js";
export { detectMultipleSourcesOfTruth } from "./detectors/multiple-sources.js";
export { detectStorageAsState } from "./detectors/storage-as-state.js";
export { detectUrlStateForked } from "./detectors/url-fork.js";
export { detectCookieAsState } from "./detectors/cookie-as-state.js";
export { detectDerivedStateAsState } from "./detectors/derived-state.js";
export { detectDefeatedMemo } from "./detectors/defeated-memo.js";
export { detectUnstableContextValue } from "./detectors/unstable-context-value.js";
export { detectPointlessMemo } from "./detectors/pointless-memo.js";
export { computeStackProfile, NEUTRAL_PROFILE } from "./detectors/stack.js";
export type { StackProfile } from "./detectors/stack.js";
export type { Finding, Severity } from "./detectors/types.js";
export { formatFindings, exitCode } from "./format.js";
export type { FormatOptions } from "./format.js";
export type {
  StateClass,
  StateKind,
  StateSource,
  ComponentNode,
  Edge,
  ReadVia,
  WriteVia,
  StateGraph,
  StateId,
  ComponentId,
  SourceLoc,
  ValueShape,
} from "./graph/schema.js";
