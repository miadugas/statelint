/**
 * Server-state-in-client-state — the wedge detector. useState/useReducer
 * classified as 'server-cache' (fed by async work in an effect) is a
 * hand-rolled server cache that belongs in a query library.
 *
 * Findings group PER EFFECT, not per field: one fetch feeding
 * firstName/lastName/email is one problem, not three. When every fed field is
 * also edited outside the effect, it's a prefilled form draft — real, but a
 * different conversation, so the finding softens to info.
 */

import type { StateGraph, StateSource } from "../graph/schema.js";
import type { Finding } from "./types.js";
import type { StackProfile } from "./stack.js";
import { NEUTRAL_PROFILE } from "./stack.js";

export function detectServerStateInClientState(
  graph: StateGraph,
  profile: StackProfile = NEUTRAL_PROFILE,
): Finding[] {
  // Group fed sources by the effect that feeds them.
  const byEffect = new Map<string, StateSource[]>();
  for (const source of graph.sources.values()) {
    if (source.kind !== "useState" && source.kind !== "useReducer") continue;
    if (source.classification !== "server-cache") continue;
    const effect = source.serverFed?.effect;
    const key = effect
      ? `${effect.file}:${effect.line}:${effect.col}`
      : source.id;
    const group = byEffect.get(key);
    if (group) group.push(source);
    else byEffect.set(key, [source]);
  }

  const findings: Finding[] = [];
  for (const group of byEffect.values()) {
    const sorted = [...group].sort((a, b) => a.loc.line - b.loc.line);
    const first = sorted[0]!;
    const names = sorted.map((s) => `'${s.name}'`).join(", ");
    const drafts = sorted.filter((s) => s.serverFed?.editedOutsideEffect);
    const allDrafts = drafts.length === sorted.length;

    const subject =
      sorted.length === 1
        ? `${names} holds server data (fetched in an effect) but lives in ${first.kind}`
        : `One effect caches server data in ${sorted.length} ${first.kind} variables (${names})`;

    findings.push({
      rule: "server-state-in-client-state",
      severity: allDrafts ? "info" : "warn",
      message: allDrafts
        ? `${subject} — and the user edits ${sorted.length === 1 ? "it" : "them"} too: a prefilled form draft built on a hand-rolled fetch.`
        : `${subject} — a hand-rolled cache with no dedup, refetch, or staleness handling${
            drafts.length > 0
              ? ` (${drafts.map((s) => `'${s.name}'`).join(", ")} also user-edited)`
              : ""
          }.`,
      recommendation: allDrafts
        ? "Fetch with useQuery and seed the draft from its data (or a form library’s defaultValues) — separate the fetching concern from the editing concern."
        : profile.serverLib === "RTK Query"
          ? "Move to RTK Query — this app already uses it: an endpoint replaces the useState + useEffect + fetch triple."
          : profile.serverLib === "TanStack Query"
            ? "Move to TanStack Query — this app already uses it: useQuery replaces the useState + useEffect + fetch triple."
            : "Move to a query library — TanStack Query's useQuery replaces the useState + useEffect + fetch triple.",
      loc: first.serverFed?.effect ?? first.loc,
      path: first.ownerComponentId ? [first.ownerComponentId] : undefined,
    });
  }

  return findings;
}
