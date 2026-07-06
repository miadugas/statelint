import { describe, expect, it } from "vitest";
import { buildStateGraph } from "./build.js";
import { detectOverBroadSelector } from "../detectors/over-broad-selector.js";
import { detectOverGlobalizedState } from "../detectors/over-globalized.js";

const CART_STORE = `
  import { create } from 'zustand';
  export const useCartStore = create((set) => ({
    items: [],
    total: 0,
    addItem: (item) => set((s) => ({ items: [...s.items, item] })),
  }));
`;

describe("zustand adapter", () => {
  it("registers create() stores with fields and global-client classification", () => {
    const graph = buildStateGraph([{ path: "src/cart.ts", code: CART_STORE }]);
    const source = graph.sources.get("src/cart.ts#useCartStore");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("zustand");
    expect(source?.classification).toBe("global-client");
    expect(source?.shape?.fields).toEqual(["items", "total", "addItem"]);
    expect(source?.fieldCount).toBe(3);
  });

  it("handles the curried create<T>()(fn) TypeScript pattern", () => {
    const graph = buildStateGraph([
      {
        path: "src/settings.ts",
        code: `
          import { create } from 'zustand';
          export const useSettings = create<Settings>()((set) => ({
            theme: 'dark',
            setTheme: (theme) => set({ theme }),
          }));
        `,
      },
    ]);
    const source = graph.sources.get("src/settings.ts#useSettings");
    expect(source?.kind).toBe("zustand");
    expect(source?.shape?.fields).toEqual(["theme", "setTheme"]);
  });

  it("ignores create() from other libraries", () => {
    const graph = buildStateGraph([
      {
        path: "src/other.ts",
        code: `
          import { create } from 'axios';
          export const useApi = create({ baseURL: '/api' });
        `,
      },
    ]);
    expect([...graph.sources.values()].some((s) => s.kind === "zustand")).toBe(
      false,
    );
  });

  it("emits selector reads, whole-store reads, and setState writes cross-file", () => {
    const graph = buildStateGraph([
      { path: "src/cart.ts", code: CART_STORE },
      {
        path: "src/Badge.tsx",
        code: `
          import { useCartStore } from './cart';
          export function Badge() {
            const total = useCartStore((s) => s.total);
            return <span>{total}</span>;
          }
        `,
      },
      {
        path: "src/Debug.tsx",
        code: `
          import { useCartStore } from './cart';
          export function Debug() {
            const store = useCartStore();
            return <pre>{JSON.stringify(store)}</pre>;
          }
        `,
      },
      {
        path: "src/Reset.tsx",
        code: `
          import { useCartStore } from './cart';
          export function Reset() {
            return <button onClick={() => useCartStore.setState({ items: [] })}>reset</button>;
          }
        `,
      },
    ]);

    const storeId = "src/cart.ts#useCartStore";
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/Badge.tsx#Badge",
      to: storeId,
      via: "selector",
    });
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/Debug.tsx#Debug",
      to: storeId,
      via: "hook",
    });
    expect(graph.edges).toContainEqual({
      type: "writes",
      from: "src/Reset.tsx#Reset",
      to: storeId,
      via: "setState",
    });
  });
});

describe("detectOverBroadSelector", () => {
  it("flags bare useStore() and the identity selector, not narrow selectors", () => {
    const graph = buildStateGraph([
      { path: "src/cart.ts", code: CART_STORE },
      {
        path: "src/app.tsx",
        code: `
          import { useCartStore } from './cart';
          export function WholeA() {
            const store = useCartStore();
            return <div>{store.total}</div>;
          }
          export function WholeB() {
            const store = useCartStore((s) => s);
            return <div>{store.total}</div>;
          }
          export function Narrow() {
            const total = useCartStore((s) => s.total);
            return <div>{total}</div>;
          }
        `,
      },
    ]);

    const findings = detectOverBroadSelector(graph);
    expect(findings).toHaveLength(2);
    const flagged = findings.map((f) => f.path?.[0]).sort();
    expect(flagged).toEqual(["src/app.tsx#WholeA", "src/app.tsx#WholeB"]);
    expect(findings[0]!.recommendation).toContain("(s) => s.items");
  });
});

describe("detectOverGlobalizedState — zustand", () => {
  it("warns when a store has exactly one reader", () => {
    const graph = buildStateGraph([
      { path: "src/cart.ts", code: CART_STORE },
      {
        path: "src/Only.tsx",
        code: `
          import { useCartStore } from './cart';
          export function Only() {
            const items = useCartStore((s) => s.items);
            return <ul>{items.length}</ul>;
          }
        `,
      },
    ]);
    const findings = detectOverGlobalizedState(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("'useCartStore'");
    expect(findings[0]!.message).toContain("Only");
    expect(findings[0]!.recommendation).toContain("useState");
  });

  it("stays quiet with multiple readers and for zero-reader stores", () => {
    const twoReaders = buildStateGraph([
      { path: "src/cart.ts", code: CART_STORE },
      {
        path: "src/A.tsx",
        code: `
          import { useCartStore } from './cart';
          export function A() {
            const items = useCartStore((s) => s.items);
            return <ul>{items.length}</ul>;
          }
        `,
      },
      {
        path: "src/B.tsx",
        code: `
          import { useCartStore } from './cart';
          export function B() {
            const total = useCartStore((s) => s.total);
            return <span>{total}</span>;
          }
        `,
      },
    ]);
    expect(detectOverGlobalizedState(twoReaders)).toHaveLength(0);

    const zeroReaders = buildStateGraph([
      { path: "src/cart.ts", code: CART_STORE },
    ]);
    expect(detectOverGlobalizedState(zeroReaders)).toHaveLength(0);
  });
});
