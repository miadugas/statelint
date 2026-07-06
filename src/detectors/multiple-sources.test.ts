import { describe, expect, it } from "vitest";
import { buildStateGraph } from "../graph/build.js";
import { detectMultipleSourcesOfTruth, entityKey } from "./multiple-sources.js";

describe("entityKey", () => {
  it("normalizes naming conventions to the underlying entity", () => {
    expect(entityKey("UserContext")).toBe("user");
    expect(entityKey("useUserStore")).toBe("user");
    expect(entityKey("cartSlice")).toBe("cart");
    expect(entityKey("ThemeProvider")).toBe("theme");
    expect(entityKey("useSettings")).toBe("settings");
  });

  it("returns null for generic or too-short names", () => {
    expect(entityKey("DataContext")).toBeNull();
    expect(entityKey("useStore")).toBeNull();
    expect(entityKey("AppContext")).toBeNull();
    expect(entityKey("StateContext")).toBeNull();
    expect(entityKey("UIContext")).toBeNull(); // 'ui' — under 3 chars
  });
});

describe("detectMultipleSourcesOfTruth", () => {
  it("fires when a context and a zustand store own the same entity", () => {
    const graph = buildStateGraph([
      {
        path: "src/userContext.tsx",
        code: `
          export const UserContext = createContext(null);
        `,
      },
      {
        path: "src/userStore.ts",
        code: `
          import { create } from 'zustand';
          export const useUserStore = create((set) => ({
            user: null,
            setUser: (user) => set({ user }),
          }));
        `,
      },
    ]);

    const findings = detectMultipleSourcesOfTruth(graph);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.rule).toBe("multiple-sources-of-truth");
    expect(finding.message).toContain("'user'");
    expect(finding.message).toContain("UserContext");
    expect(finding.message).toContain("useUserStore");
    expect(finding.path).toEqual([
      "src/userContext.tsx#UserContext",
      "src/userStore.ts#useUserStore",
    ]);
  });

  it("fires on two same-entity contexts in different files", () => {
    const graph = buildStateGraph([
      {
        path: "src/a/theme.tsx",
        code: `export const ThemeContext = createContext('light');`,
      },
      {
        path: "src/b/theme.tsx",
        code: `export const ThemeCtx = createContext('dark');`,
      },
    ]);
    const findings = detectMultipleSourcesOfTruth(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("'theme'");
  });

  it("stays quiet for distinct entities", () => {
    const graph = buildStateGraph([
      {
        path: "src/theme.tsx",
        code: `export const ThemeContext = createContext('light');`,
      },
      {
        path: "src/cart.ts",
        code: `
          import { create } from 'zustand';
          export const useCartStore = create(() => ({ items: [] }));
        `,
      },
    ]);
    expect(detectMultipleSourcesOfTruth(graph)).toHaveLength(0);
  });

  it("suppresses generic entity names instead of guessing", () => {
    const graph = buildStateGraph([
      {
        path: "src/data.tsx",
        code: `export const DataContext = createContext(null);`,
      },
      {
        path: "src/dataStore.ts",
        code: `
          import { create } from 'zustand';
          export const useDataStore = create(() => ({ rows: [] }));
        `,
      },
    ]);
    expect(detectMultipleSourcesOfTruth(graph)).toHaveLength(0);
  });

  it("does not flag a local useState sharing a global entity's name (v1 scope)", () => {
    const graph = buildStateGraph([
      {
        path: "src/user.tsx",
        code: `export const UserContext = createContext(null);`,
      },
      {
        path: "src/EditForm.tsx",
        code: `
          export function EditForm() {
            const [user, setUser] = useState(null);
            return <input value={user?.name} />;
          }
        `,
      },
    ]);
    expect(detectMultipleSourcesOfTruth(graph)).toHaveLength(0);
  });
});
