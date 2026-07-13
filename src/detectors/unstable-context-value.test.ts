import { describe, expect, it } from "vitest";
import { buildStateGraph } from "../graph/build.js";
import { detectUnstableContextValue } from "./unstable-context-value.js";

describe("detectUnstableContextValue", () => {
  it("flags <Ctx.Provider value={{...}}> with a useContext consumer", () => {
    const graph = buildStateGraph([
      {
        path: "src/user.tsx",
        code: `
          import { createContext } from 'react';
          export const UserContext = createContext(null);
        `,
      },
      {
        path: "src/App.tsx",
        code: `
          import { UserContext } from './user';
          import { Profile } from './Profile';
          export function App() {
            const [user, setUser] = useState(null);
            return (
              <UserContext.Provider value={{ user, setUser }}>
                <Profile />
              </UserContext.Provider>
            );
          }
        `,
      },
      {
        path: "src/Profile.tsx",
        code: `
          import { useContext } from 'react';
          import { UserContext } from './user';
          export function Profile() {
            const { user } = useContext(UserContext);
            return <span>{user?.name}</span>;
          }
        `,
      },
    ]);

    const findings = detectUnstableContextValue(graph);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.rule).toBe("unstable-context-value");
    expect(finding.severity).toBe("warn");
    expect(finding.message).toContain("UserContext");
    expect(finding.message).toContain("App");
    expect(finding.message).toContain("consumer(s)");
    expect(finding.recommendation).toContain("useMemo");
    expect(finding.path).toEqual(["src/App.tsx#App"]);
  });

  it("flags the React 19 bare provider <Ctx value={{...}}>", () => {
    const graph = buildStateGraph([
      {
        path: "src/theme.tsx",
        code: `
          const ThemeContext = createContext(null);
          export function Root() {
            const [theme, setTheme] = useState('dark');
            return (
              <ThemeContext value={{ theme }}>
                <Panel />
              </ThemeContext>
            );
          }
          function Panel() {
            const { theme } = use(ThemeContext);
            return <div className={theme} />;
          }
        `,
      },
    ]);

    const findings = detectUnstableContextValue(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("ThemeContext");
    expect(findings[0]!.message).toContain("Root");
  });

  it("does not flag value={useMemo(...)} — a CallExpression, not a literal", () => {
    const graph = buildStateGraph([
      {
        path: "src/user.tsx",
        code: `
          const UserContext = createContext(null);
          export function App() {
            const [user, setUser] = useState(null);
            const value = useMemo(() => ({ user, setUser }), [user]);
            return (
              <UserContext.Provider value={useMemo(() => ({ user }), [user])}>
                <Profile />
              </UserContext.Provider>
            );
          }
          function Profile() {
            const { user } = useContext(UserContext);
            return <span>{user?.name}</span>;
          }
        `,
      },
    ]);

    expect(detectUnstableContextValue(graph)).toHaveLength(0);
  });

  it("does not flag value={identifier} — a stable reference", () => {
    const graph = buildStateGraph([
      {
        path: "src/user.tsx",
        code: `
          const UserContext = createContext(null);
          export function App() {
            const [user, setUser] = useState(null);
            const ctxValue = useMemo(() => ({ user, setUser }), [user]);
            return (
              <UserContext.Provider value={ctxValue}>
                <Profile />
              </UserContext.Provider>
            );
          }
          function Profile() {
            const { user } = useContext(UserContext);
            return <span>{user?.name}</span>;
          }
        `,
      },
    ]);

    expect(detectUnstableContextValue(graph)).toHaveLength(0);
  });

  it("stays quiet when the inline provider has zero consumers", () => {
    const graph = buildStateGraph([
      {
        path: "src/user.tsx",
        code: `
          const UserContext = createContext(null);
          export function App() {
            const [user, setUser] = useState(null);
            return (
              <UserContext.Provider value={{ user, setUser }}>
                <div />
              </UserContext.Provider>
            );
          }
        `,
      },
    ]);

    expect(detectUnstableContextValue(graph)).toHaveLength(0);
  });

  it("flags an inline arrow function value with a consumer", () => {
    const graph = buildStateGraph([
      {
        path: "src/actions.tsx",
        code: `
          const ActionContext = createContext(null);
          export function App() {
            return (
              <ActionContext.Provider value={() => {}}>
                <Button />
              </ActionContext.Provider>
            );
          }
          function Button() {
            const onClick = useContext(ActionContext);
            return <button onClick={onClick} />;
          }
        `,
      },
    ]);

    const findings = detectUnstableContextValue(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("ActionContext");
  });

  it("fires when consumption flows through a custom hook wrapping useContext", () => {
    const graph = buildStateGraph([
      {
        path: "src/lockContext.ts",
        code: `
          import { createContext, useContext } from 'react';
          export const LockContext = createContext(null);
          export function useLock() {
            const ctx = useContext(LockContext);
            if (!ctx) throw new Error('useLock must be used within a LockProvider');
            return ctx;
          }
        `,
      },
      {
        path: "src/LockProvider.tsx",
        code: `
          import { LockContext } from './lockContext';
          export function LockProvider({ children }) {
            const [unlocked, setUnlocked] = useState(false);
            return <LockContext.Provider value={{ unlocked }}>{children}</LockContext.Provider>;
          }
        `,
      },
      {
        path: "src/LockScreen.tsx",
        code: `
          import { useLock } from './lockContext';
          export function LockScreen() {
            const { unlocked } = useLock();
            return unlocked ? null : <div>locked</div>;
          }
        `,
      },
    ]);

    // Confirm the transitive consumes edge the detector relies on exists.
    const ctxId = "src/lockContext.ts#LockContext";
    expect(
      graph.edges.some(
        (e) =>
          e.type === "consumes" &&
          e.to === ctxId &&
          e.from === "src/LockScreen.tsx#LockScreen",
      ),
    ).toBe(true);

    const findings = detectUnstableContextValue(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("LockContext");
    expect(findings[0]!.message).toContain("LockProvider");
  });

  it("never fires on Vue provide/inject (kind gate)", () => {
    const SFC = (script: string) =>
      `<script setup>${script}</script>\n<template><div /></template>`;
    const graph = buildStateGraph([
      {
        path: "App.vue",
        code: SFC(`
          import { ref, provide } from 'vue';
          const theme = ref('dark');
          provide('theme', theme);
        `),
      },
      {
        path: "Footer.vue",
        code: SFC(`
          import { inject } from 'vue';
          const theme = inject('theme');
        `),
      },
    ]);

    expect(detectUnstableContextValue(graph)).toHaveLength(0);
  });
});
