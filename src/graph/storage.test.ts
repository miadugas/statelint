import { describe, expect, it } from "vitest";
import { buildStateGraph } from "./build.js";
import { detectMultipleSourcesOfTruth } from "../detectors/multiple-sources.js";
import { detectStorageAsState } from "../detectors/storage-as-state.js";

describe("web storage adapter", () => {
  it("registers keys as sources with reads/writes edges", () => {
    const graph = buildStateGraph([
      {
        path: "src/Cart.tsx",
        code: `
          export function Cart() {
            const [items, setItems] = useState(() => JSON.parse(localStorage.getItem('cart') ?? '[]'));
            const save = (next) => {
              setItems(next);
              localStorage.setItem('cart', JSON.stringify(next));
            };
            return <ul onClick={() => save([])}>{items.length}</ul>;
          }
        `,
      },
    ]);

    const source = graph.sources.get("storage:local:cart");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("local-storage");
    expect(source?.classification).toBe("global-client");
    expect(source?.name).toBe("cart");
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/Cart.tsx#Cart",
      to: "storage:local:cart",
      via: "hook",
    });
    expect(graph.edges).toContainEqual({
      type: "writes",
      from: "src/Cart.tsx#Cart",
      to: "storage:local:cart",
      via: "mutate",
    });
  });

  it("distinguishes sessionStorage and handles window.localStorage", () => {
    const graph = buildStateGraph([
      {
        path: "src/Wizard.tsx",
        code: `
          export function Wizard() {
            const step = sessionStorage.getItem('wizard-step');
            const reset = () => window.localStorage.removeItem('draft');
            return <div onClick={reset}>{step}</div>;
          }
        `,
      },
    ]);
    expect(graph.sources.get("storage:session:wizard-step")?.kind).toBe(
      "session-storage",
    );
    expect(graph.sources.get("storage:local:draft")?.kind).toBe(
      "local-storage",
    );
  });

  it("skips dynamic keys instead of guessing", () => {
    const graph = buildStateGraph([
      {
        path: "src/Dyn.tsx",
        code: `
          export function Dyn({ id }) {
            const value = localStorage.getItem('item-' + id);
            return <span>{value}</span>;
          }
        `,
      },
    ]);
    expect(
      [...graph.sources.values()].some((s) => s.kind === "local-storage"),
    ).toBe(false);
  });

  it("attributes storage access through custom hooks (fixpoint)", () => {
    const graph = buildStateGraph([
      {
        path: "src/useToken.ts",
        code: `
          export function useToken() {
            return localStorage.getItem('token');
          }
        `,
      },
      {
        path: "src/Nav.tsx",
        code: `
          import { useToken } from './useToken';
          export function Nav() {
            const token = useToken();
            return token ? <a href="/app">App</a> : <a href="/login">Login</a>;
          }
        `,
      },
    ]);
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/Nav.tsx#Nav",
      to: "storage:local:token",
      via: "hook",
    });
  });
});

describe("detectStorageAsState", () => {
  const READER = `
    export function Badge() {
      const raw = localStorage.getItem('cart');
      return <span>{JSON.parse(raw ?? '[]').length}</span>;
    }
  `;
  const WRITER = `
    export function AddButton() {
      const add = (item) => {
        const next = [...JSON.parse(localStorage.getItem('cart') ?? '[]'), item];
        localStorage.setItem('cart', JSON.stringify(next));
      };
      return <button onClick={() => add({})}>Add</button>;
    }
  `;

  it("warns when multiple components share a written key", () => {
    const graph = buildStateGraph([
      { path: "src/Badge.tsx", code: READER },
      { path: "src/AddButton.tsx", code: WRITER },
    ]);
    const findings = detectStorageAsState(graph);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.rule).toBe("storage-as-state");
    expect(finding.message).toContain("'cart'");
    expect(finding.message).toContain("AddButton");
    expect(finding.message).toContain("Badge");
    expect(finding.message).toContain("isn't reactive");
    expect(finding.recommendation).toContain("persist");
  });

  it("stays quiet for single-owner persistence", () => {
    const graph = buildStateGraph([
      {
        path: "src/Settings.tsx",
        code: `
          export function Settings() {
            const [theme, setTheme] = useState(() => localStorage.getItem('theme') ?? 'light');
            const pick = (t) => {
              setTheme(t);
              localStorage.setItem('theme', t);
            };
            return <button onClick={() => pick('dark')}>{theme}</button>;
          }
        `,
      },
    ]);
    expect(detectStorageAsState(graph)).toHaveLength(0);
  });

  it("stays quiet for read-only keys (config injected elsewhere)", () => {
    const readOnly = (name: string) => `
      export function ${name}() {
        const flag = localStorage.getItem('feature-flag');
        return flag ? <div /> : null;
      }
    `;
    const graph = buildStateGraph([
      { path: "src/A.tsx", code: readOnly("FlagA") },
      { path: "src/B.tsx", code: readOnly("FlagB") },
    ]);
    expect(detectStorageAsState(graph)).toHaveLength(0);
  });
});

describe("multiple-sources-of-truth — storage joins the global kinds", () => {
  it("flags a zustand store competing with a localStorage key", () => {
    const graph = buildStateGraph([
      {
        path: "src/userStore.ts",
        code: `
          import { create } from 'zustand';
          export const useUserStore = create(() => ({ user: null }));
        `,
      },
      {
        path: "src/Login.tsx",
        code: `
          export function Login() {
            const submit = (u) => localStorage.setItem('user', JSON.stringify(u));
            return <button onClick={() => submit({})}>Login</button>;
          }
        `,
      },
    ]);
    const findings = detectMultipleSourcesOfTruth(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("'user'");
    expect(findings[0]!.message).toContain("localStorage key 'user'");
    expect(findings[0]!.message).toContain("useUserStore");
  });
});
