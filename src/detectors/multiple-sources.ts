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
    source.kind === "context"
      ? "context"
      : source.kind === "zustand" || source.kind === "redux-slice"
        ? `${source.kind} store`
        : source.kind === "tanstack-query" || source.kind === "rtk-query"
          ? "query"
          : source.kind; // useState/useReducer read naturally as-is
  return `${kindLabel} '${source.name}' (${source.loc.file}:${source.loc.line})`;
}

function groupByEntity(sources: StateSource[]): Map<string, StateSource[]> {
  const byEntity = new Map<string, StateSource[]>();
  for (const source of sources) {
    const key = entityKey(source.name);
    if (!key) continue;
    const group = byEntity.get(key);
    if (group) group.push(source);
    else byEntity.set(key, [source]);
  }
  return byEntity;
}

export function detectMultipleSourcesOfTruth(graph: StateGraph): Finding[] {
  const findings: Finding[] = [];
  const all = [...graph.sources.values()];

  // Pass 1: competing GLOBAL owners (context vs zustand vs …).
  const globalGroups = groupByEntity(
    all.filter((s) => GLOBAL_KINDS.has(s.kind)),
  );
  for (const [entity, group] of globalGroups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) =>
      a.loc.file.localeCompare(b.loc.file),
    );
    findings.push({
      rule: "multiple-sources-of-truth",
      severity: "warn",
      message: `Entity '${entity}' has ${sorted.length} competing sources of truth: ${sorted
        .map(describe)
        .join(", ")}. They will drift.`,
      recommendation:
        "Pick one owner for this entity and delete the others; consumers read the single source (directly or via one adapter hook).",
      loc: sorted[0]!.loc,
      path: sorted.map((s) => s.id),
    });
  }

  // Pass 2: duplicated SERVER caches — a query plus hand-rolled fetch state
  // (or several hand-rolled caches) holding the same server entity.
  const serverGroups = groupByEntity(
    all.filter((s) => s.classification === "server-cache"),
  );
  for (const [entity, group] of serverGroups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) =>
      a.loc.file.localeCompare(b.loc.file),
    );
    const hasQuery = sorted.some((s) => s.kind === "tanstack-query");
    findings.push({
      rule: "multiple-sources-of-truth",
      severity: "warn",
      message: `Server entity '${entity}' is cached in ${sorted.length} independent places: ${sorted
        .map(describe)
        .join(
          ", ",
        )}. Hand-rolled caches drift from each other${hasQuery ? " and from the query cache" : ""}.`,
      recommendation: hasQuery
        ? `Read '${entity}' via the existing query everywhere and delete the manual fetch caches.`
        : `Cache '${entity}' once in a query library (TanStack Query) and delete the per-component copies.`,
      loc: sorted[0]!.loc,
      path: sorted.map((s) => s.id),
    });
  }

  return findings;
}
