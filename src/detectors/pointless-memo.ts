/**
 * Pointless useMemo/useCallback — structurally broken memoization the builder
 * proved at the AST: no dependency array (recomputes every render), or an
 * inline literal in the deps (new reference every render, cache never hits).
 *
 * The fuzzier case — "result never reaches anything memoized" — is deliberately
 * NOT flagged: refs, effect deps, and context values are legitimate consumers.
 */

import type { StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export function detectPointlessMemo(graph: StateGraph): Finding[] {
  return graph.memoIssues.map((issue) => {
    const owner =
      graph.components.get(issue.ownerId)?.name ??
      issue.ownerId.split("#").pop() ??
      issue.ownerId;
    return issue.issue === "no-deps"
      ? {
          rule: "pointless-memo",
          severity: "warn" as const,
          message: `${issue.kind} in ${owner} has no dependency array — it re-runs on every render, memoizing nothing.`,
          recommendation: `Add the dependency array, or delete the ${issue.kind} and compute inline; as written it's overhead with zero caching.`,
          loc: issue.loc,
          path: [issue.ownerId],
        }
      : {
          rule: "pointless-memo",
          severity: "warn" as const,
          message: `${issue.kind} in ${owner} has an inline object/array/function in its dependency array — a new reference every render, so the cache never hits.`,
          recommendation: `Hoist or memoize that dependency (or depend on its fields) so the array is referentially stable.`,
          loc: issue.loc,
          path: [issue.ownerId],
        };
  });
}
