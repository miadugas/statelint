import type { SourceLoc } from "../graph/schema.js";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  /** Rule id, kebab-case: 'prop-drilling', 'server-state-in-client-state', … */
  rule: string;
  severity: Severity;
  /** What's wrong, with names — never generic. */
  message: string;
  /** Where to point the user (component or state declaration). */
  loc: SourceLoc;
  /** The named refactor. Every finding ships one — prescriptive is the product. */
  recommendation: string;
  /** Component ids involved, in path order where applicable. */
  path?: string[];
}
