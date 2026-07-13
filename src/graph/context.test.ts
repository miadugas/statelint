import { describe, expect, it } from "vitest";
import { buildStateGraph } from "./build.js";

describe("context adapter", () => {
  it("registers createContext as a global-client source with provides/consumes edges", () => {
    const graph = buildStateGraph([
      {
        path: "src/theme.tsx",
        code: `
          import { createContext } from 'react';
          export const ThemeContext = createContext('light');
        `,
      },
      {
        path: "src/App.tsx",
        code: `
          import { ThemeContext } from './theme';
          import { Toolbar } from './Toolbar';
          import { StatusBar } from './StatusBar';
          export function App() {
            const [theme, setTheme] = useState('light');
            return (
              <ThemeContext.Provider value={theme}>
                <Toolbar />
                <StatusBar />
              </ThemeContext.Provider>
            );
          }
        `,
      },
      {
        path: "src/Toolbar.tsx",
        code: `
          import { useContext } from 'react';
          import { ThemeContext } from './theme';
          export function Toolbar() {
            const theme = useContext(ThemeContext);
            return <div className={theme} />;
          }
        `,
      },
      {
        path: "src/StatusBar.tsx",
        code: `
          import { use } from 'react';
          import { ThemeContext } from './theme';
          export function StatusBar() {
            const theme = use(ThemeContext);
            return <footer className={theme} />;
          }
        `,
      },
    ]);

    const ctxId = "src/theme.tsx#ThemeContext";
    const source = graph.sources.get(ctxId);
    expect(source).toBeDefined();
    expect(source?.kind).toBe("context");
    expect(source?.classification).toBe("global-client");

    expect(
      graph.edges.some(
        (e) =>
          e.type === "provides" &&
          e.from === "src/App.tsx#App" &&
          e.to === ctxId,
      ),
    ).toBe(true);

    const consumers = graph.edges
      .filter((e) => e.type === "consumes" && e.to === ctxId)
      .map((e) => e.from)
      .sort();
    expect(consumers).toEqual([
      "src/StatusBar.tsx#StatusBar",
      "src/Toolbar.tsx#Toolbar",
    ]);
  });

  it("handles React.createContext and same-file usage", () => {
    const graph = buildStateGraph([
      {
        path: "src/counter.tsx",
        code: `
          const CountContext = React.createContext(0);
          export function CounterRoot() {
            const [count, setCount] = useState(0);
            return (
              <CountContext.Provider value={count}>
                <Display />
              </CountContext.Provider>
            );
          }
          function Display() {
            const count = useContext(CountContext);
            return <span>{count}</span>;
          }
        `,
      },
    ]);

    const ctxId = "src/counter.tsx#CountContext";
    expect(graph.sources.get(ctxId)?.kind).toBe("context");
    expect(
      graph.edges.some((e) => e.type === "provides" && e.to === ctxId),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) =>
          e.type === "consumes" &&
          e.to === ctxId &&
          e.from === "src/counter.tsx#Display",
      ),
    ).toBe(true);
  });

  it("sees consumption through a custom hook (the tlog useLock pattern)", () => {
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
      {
        path: "src/MoreScreen.tsx",
        code: `
          import { useLock } from './lockContext';
          export function MoreScreen() {
            const lock = useLock();
            return <button onClick={lock.lock}>Lock now</button>;
          }
        `,
      },
    ]);

    const ctxId = "src/lockContext.ts#LockContext";
    const consumers = graph.edges
      .filter((e) => e.type === "consumes" && e.to === ctxId)
      .map((e) => e.from)
      .sort();
    expect(consumers).toEqual([
      "src/LockScreen.tsx#LockScreen",
      "src/MoreScreen.tsx#MoreScreen",
    ]);
  });

  it("resolves hook-through-hook consumption (fixpoint)", () => {
    const graph = buildStateGraph([
      {
        path: "src/auth.ts",
        code: `
          export const AuthContext = createContext(null);
          export function useAuth() {
            return useContext(AuthContext);
          }
          export function useIsAdmin() {
            const auth = useAuth();
            return auth?.role === 'admin';
          }
        `,
      },
      {
        path: "src/AdminBadge.tsx",
        code: `
          import { useIsAdmin } from './auth';
          export function AdminBadge() {
            const isAdmin = useIsAdmin();
            return isAdmin ? <span>admin</span> : null;
          }
        `,
      },
    ]);

    expect(
      graph.edges.some(
        (e) =>
          e.type === "consumes" &&
          e.to === "src/auth.ts#AuthContext" &&
          e.from === "src/AdminBadge.tsx#AdminBadge",
      ),
    ).toBe(true);
  });

  it("supports the React 19 bare provider element (<Ctx value={...}>)", () => {
    const graph = buildStateGraph([
      {
        path: "src/modern.tsx",
        code: `
          const UserContext = createContext(null);
          export function Root() {
            const [user, setUser] = useState(null);
            return (
              <UserContext value={user}>
                <Profile />
              </UserContext>
            );
          }
          function Profile() {
            const user = use(UserContext);
            return <span>{user?.name}</span>;
          }
        `,
      },
    ]);
    expect(
      graph.edges.some(
        (e) => e.type === "provides" && e.to === "src/modern.tsx#UserContext",
      ),
    ).toBe(true);
  });
});
