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
    if (
      source.kind !== "useState" &&
      source.kind !== "useReducer" &&
      source.kind !== "ref" &&
      source.kind !== "reactive" &&
      source.kind !== "options-data"
    )
      continue;
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

    // Wording keys on the source kind — the only framework evidence we have.
    const options = first.kind === "options-data";
    const reactive = first.kind === "reactive";
    const vue = first.kind === "ref" || reactive || options;
    // options-data reads as `data()`; reactive as `reactive(...)`;
    // ref/useState/useReducer read as-is.
    const kindLabel = options
      ? "data()"
      : reactive
        ? "reactive(...)"
        : first.kind;
    const where = options
      ? "a lifecycle hook"
      : vue
        ? "a lifecycle hook or watcher"
        : "an effect";
    const triple = options
      ? "the data() + lifecycle-hook + fetch triple"
      : reactive
        ? "the reactive + onMounted + fetch triple"
        : vue
          ? "the ref + onMounted + fetch triple"
          : "the useState + useEffect + fetch triple";

    const subject =
      sorted.length === 1
        ? `${names} holds server data (fetched in ${where}) but lives in ${kindLabel}`
        : `One ${vue ? "lifecycle hook" : "effect"} caches server data in ${sorted.length} ${kindLabel} variables (${names})`;

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
        : // "this app already uses it" is only honest for React-kind sources:
          // RTK Query is React-only, and react-query / vue-query share the
          // "tanstack-query" kind, so a Vue-kind source can't prove the app
          // uses the Vue flavor. Vue-kind sources fall through to the
          // Nuxt/vue-query wording, which names the package without claiming it.
          !vue && profile.serverLib === "RTK Query"
          ? `Move to RTK Query — this app already uses it: an endpoint replaces ${triple}.`
          : !vue && profile.serverLib === "TanStack Query"
            ? `Move to TanStack Query — this app already uses it: useQuery replaces ${triple}.`
            : vue && profile.nuxt
              ? `Move to Nuxt's useAsyncData/useFetch — data, pending, and error replace ${triple} (or @tanstack/vue-query for richer caching).`
              : `Move to a query library — TanStack Query's useQuery${vue ? " (@tanstack/vue-query)" : ""} replaces ${triple}.`,
      loc: first.serverFed?.effect ?? first.loc,
      path: first.ownerComponentId ? [first.ownerComponentId] : undefined,
    });
  }

  return findings;
}
