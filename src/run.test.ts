import { describe, expect, it } from "vitest";
import { runStatelint } from "./run.js";

describe("runStatelint", () => {
  it("runs all detectors and sorts findings by file then line", () => {
    const findings = runStatelint([
      {
        path: "b-drill.tsx",
        code: `
          function App() {
            const [user, setUser] = useState({ name: 'Ada' });
            return <Layout user={user} />;
          }
          function Layout({ user }) {
            return <Sidebar user={user} />;
          }
          function Sidebar({ user }) {
            return <Profile user={user} />;
          }
          function Profile({ user }) {
            return <h1>{user.name}</h1>;
          }
        `,
      },
      {
        path: "a-fetch.tsx",
        code: `
          function Users() {
            const [users, setUsers] = useState([]);
            useEffect(() => {
              fetch('/api/users').then((r) => r.json()).then(setUsers);
            }, []);
            return <ul>{users.length}</ul>;
          }
        `,
      },
    ]);

    expect(findings.map((f) => f.rule)).toEqual([
      "server-state-in-client-state",
      "prop-drilling",
    ]);
    expect(findings[0]!.loc.file).toBe("a-fetch.tsx");
    expect(findings[1]!.loc.file).toBe("b-drill.tsx");
  });

  it("returns an empty list for clean code", () => {
    const findings = runStatelint([
      {
        path: "clean.tsx",
        code: `
          function Counter() {
            const [count, setCount] = useState(0);
            return <button onClick={() => setCount(count + 1)}>{count}</button>;
          }
        `,
      },
    ]);
    expect(findings).toEqual([]);
  });

  it("skips unparseable files via onParseError instead of throwing", () => {
    const skipped: string[] = [];
    const findings = runStatelint(
      [
        { path: "broken.tsx", code: "function ??? not valid" },
        {
          path: "good.tsx",
          code: `
            function Ok() {
              const [x, setX] = useState(0);
              return <span>{x}</span>;
            }
          `,
        },
      ],
      { onParseError: (path) => skipped.push(path) },
    );
    expect(skipped).toEqual(["broken.tsx"]);
    expect(findings).toEqual([]);
  });

  it("throws on parse errors when no handler is given", () => {
    expect(() =>
      runStatelint([{ path: "broken.tsx", code: "function ??? not valid" }]),
    ).toThrow();
  });
});
