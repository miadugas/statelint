/**
 * Multiple sources of truth — the flagship cross-library detector. The same
 * entity ('user', 'cart', …) owned by two or more GLOBAL state sources
 * (context, zustand, redux later) is a consistency bug waiting to happen:
 * they *will* drift.
 *
 * Scope guard: only global-vs-global fires. A local useState named like a
 * global entity may be a legitimate draft/form copy — that's the (future)
 * forked-state detector's job, with initialization analysis to prove it.
 */

import type { StateGraph, StateSource } from "../graph/schema.js";
import type { Finding } from "./types.js";

/** Kinds that hold app-global client state — grows as adapters land (redux-slice next). */
const GLOBAL_KINDS = new Set(["context", "zustand"]);

/** Entities too generic to mean anything — matching on these is noise, not signal. */
const GENERIC_ENTITIES = new Set([
  "app",
  "context",
  "data",
  "global",
  "info",
  "main",
  "state",
  "store",
  "value",
  "values",
]);

/**
 * Normalize a source name to the entity it holds:
 * UserContext → user, useUserStore → user, cartSlice → cart.
 * Returns null when no meaningful entity remains.
 */
export function entityKey(name: string): string | null {
  let key = name;
  if (/^use[A-Z]/.test(key)) key = key.slice(3); // hook-style store names

  const AFFIXES = /(Context|Provider|Store|State|Slice|Ctx)$/;
  while (AFFIXES.test(key)) key = key.replace(AFFIXES, "");

  key = key.toLowerCase();
  if (key.length < 3 || GENERIC_ENTITIES.has(key)) return null;
  return key;
}

function describe(source: StateSource): string {
  const kindLabel =
    source.kind === "context" ? "context" : `${source.kind} store`;
  return `${kindLabel} '${source.name}' (${source.loc.file}:${source.loc.line})`;
}

export function detectMultipleSourcesOfTruth(graph: StateGraph): Finding[] {
  const byEntity = new Map<string, StateSource[]>();

  for (const source of graph.sources.values()) {
    if (!GLOBAL_KINDS.has(source.kind)) continue;
    const key = entityKey(source.name);
    if (!key) continue;
    const group = byEntity.get(key);
    if (group) group.push(source);
    else byEntity.set(key, [source]);
  }

  const findings: Finding[] = [];
  for (const [entity, group] of byEntity) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) =>
      a.loc.file.localeCompare(b.loc.file),
    );
    const first = sorted[0]!;

    findings.push({
      rule: "multiple-sources-of-truth",
      severity: "warn",
      message: `Entity '${entity}' has ${sorted.length} competing sources of truth: ${sorted
        .map(describe)
        .join(", ")}. They will drift.`,
      recommendation:
        "Pick one owner for this entity and delete the others; consumers read the single source (directly or via one adapter hook).",
      loc: first.loc,
      path: sorted.map((s) => s.id),
    });
  }

  return findings;
}
