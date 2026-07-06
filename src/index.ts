export { buildStateGraph } from "./graph/build.js";
export type { SourceFileInput } from "./graph/build.js";
export { detectPropDrilling } from "./detectors/prop-drilling.js";
export type { PropDrillingOptions } from "./detectors/prop-drilling.js";
export { detectServerStateInClientState } from "./detectors/server-state.js";
export { detectOverGlobalizedState } from "./detectors/over-globalized.js";
export { detectOverBroadSelector } from "./detectors/over-broad-selector.js";
export { detectMultipleSourcesOfTruth } from "./detectors/multiple-sources.js";
export type { Finding, Severity } from "./detectors/types.js";
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
