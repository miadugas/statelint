/**
 * Tripwire for the landing-page graph (site/index.html, "The model" section).
 * The SVG there claims to be the literal scan of examples/mixed-app — six
 * sources, the drawn read/write edges, and exactly one finding:
 * multiple-sources-of-truth on the cart entity (pinia:cart vs the
 * localStorage "cart" key). If this test fails, the drawing has drifted from
 * reality — fix the fixture or redraw the SVG, never ship the lie.
 */

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { discoverFiles } from "../discover.js";
import { buildStateGraph } from "./build.js";
import type { SourceFileInput } from "./build.js";
import { runStatelinter } from "../run.js";

const FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../examples/mixed-app",
);

const files: SourceFileInput[] = [];
discoverFiles(FIXTURE, files);
const graph = buildStateGraph(files);

/** Assert a drawn edge exists: component (by `File#Name` suffix) → source. */
function expectEdge(type: "reads" | "writes", from: string, to: string): void {
  const hit = graph.edges.some(
    (e) => e.type === type && e.from.endsWith(from) && e.to.endsWith(to),
  );
  expect(hit, `${type} edge ${from} -> ${to}`).toBe(true);
}

describe("site graph fixture (examples/mixed-app)", () => {
  it("contains exactly the six sources the SVG draws, with the drawn kinds", () => {
    const drawn = [...graph.sources.values()]
      .map((s) => `${s.kind}:${s.name}`)
      .sort();
    expect(drawn).toEqual(
      [
        "zustand:useUiStore",
        "url-param:tab",
        "useState:user",
        "tanstack-query:todos",
        "pinia:cart",
        "local-storage:cart",
      ].sort(),
    );
  });

  it("contains exactly the five components the SVG draws", () => {
    const names = [...graph.components.keys()]
      .map((id) => id.slice(id.lastIndexOf("/") + 1))
      .sort();
    expect(names).toEqual([
      "Badge.vue#Badge",
      "Cart.tsx#Cart",
      "Checkout.vue#Checkout",
      "Header.tsx#Header",
      "Profile.tsx#Profile",
    ]);
  });

  it("contains every read/write edge the SVG draws", () => {
    expectEdge("reads", "Header.tsx#Header", "stores/ui.ts#useUiStore");
    expectEdge("writes", "Header.tsx#Header", "stores/ui.ts#useUiStore");
    expectEdge("reads", "Header.tsx#Header", "url:tab");
    expectEdge("reads", "Profile.tsx#Profile", "Profile.tsx#Profile.user");
    expectEdge("writes", "Profile.tsx#Profile", "Profile.tsx#Profile.user");
    expectEdge("reads", "Profile.tsx#Profile", "query:todos");
    expectEdge("reads", "Profile.tsx#Profile", "stores/ui.ts#useUiStore");
    expectEdge("reads", "Badge.vue#Badge", "pinia:cart");
    expectEdge("reads", "Checkout.vue#Checkout", "pinia:cart");
    expectEdge("writes", "Checkout.vue#Checkout", "pinia:cart");
    expectEdge("reads", "Cart.tsx#Cart", "storage:local:cart");
    expectEdge("writes", "Cart.tsx#Cart", "storage:local:cart");
  });

  it("yields exactly one finding: multiple-sources-of-truth on cart", () => {
    const findings = runStatelinter(files);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.rule).toBe("multiple-sources-of-truth");
    expect(finding.message).toContain("Entity 'cart'");
    expect(finding.message).toContain("pinia store 'cart'");
    expect(finding.message).toContain("localStorage key 'cart'");
  });
});
