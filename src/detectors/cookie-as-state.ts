/**
 * Cookie-as-state — a cookie shared across components through NON-reactive
 * access (js-cookie / document.cookie): writes never re-render readers, and
 * mixing raw writes with react-cookie readers silently breaks the reactive
 * half. Apps that go all-in on react-cookie's useCookies are reactive by
 * construction and stay quiet here.
 */

import type { StateGraph } from "../graph/schema.js";
import type { Finding } from "./types.js";

export function detectCookieAsState(graph: StateGraph): Finding[] {
  const findings: Finding[] = [];

  for (const source of graph.sources.values()) {
    if (source.kind !== "cookie") continue;

    const readers = new Set<string>();
    const writers = new Set<string>();
    let rawAccess = false;
    let reactiveAccess = false;

    for (const edge of graph.edges) {
      if (edge.to !== source.id) continue;
      if (edge.type === "reads") {
        readers.add(edge.from);
        if (edge.via === "hook") rawAccess = true;
        if (edge.via === "context") reactiveAccess = true;
      } else if (edge.type === "writes") {
        writers.add(edge.from);
        if (edge.via === "mutate") rawAccess = true;
        if (edge.via === "setter") reactiveAccess = true;
      }
    }

    const touchers = new Set([...readers, ...writers]);
    if (touchers.size < 2 || writers.size === 0 || !rawAccess) continue;

    const names = [...touchers]
      .map((id) => graph.components.get(id)?.name ?? id)
      .sort();
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? ` +${names.length - 3} more` : "";

    findings.push({
      rule: "cookie-as-state",
      severity: "warn",
      message: reactiveAccess
        ? `Cookie '${source.name}' mixes react-cookie with raw access across ${touchers.size} components (${shown}${more}) — raw writes never notify the reactive readers.`
        : `Cookie '${source.name}' is used as a shared store by ${touchers.size} components (${shown}${more}) — cookie access isn't reactive, so writes never re-render readers.`,
      recommendation: `Give '${source.name}' one reactive owner: react-cookie's useCookies everywhere, or a store that syncs the cookie as an effect — never write it from two mechanisms.`,
      loc: source.loc,
      path: names,
    });
  }

  return findings;
}
