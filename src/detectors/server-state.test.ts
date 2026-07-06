import { describe, expect, it } from "vitest";
import { buildStateGraph } from "../graph/build.js";
import { detectServerStateInClientState } from "./server-state.js";

describe("detectServerStateInClientState", () => {
  it("fires on the fetch().then(set) pattern", () => {
    const graph = buildStateGraph([
      {
        path: "users.tsx",
        code: `
          function Users() {
            const [users, setUsers] = useState([]);
            useEffect(() => {
              fetch('/api/users')
                .then((r) => r.json())
                .then((data) => setUsers(data));
            }, []);
            return <ul>{users.length}</ul>;
          }
        `,
      },
    ]);
    const findings = detectServerStateInClientState(graph);

    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.rule).toBe("server-state-in-client-state");
    expect(finding.message).toContain("'users'");
    expect(finding.recommendation).toContain("TanStack Query");
    expect(finding.path).toEqual(["users.tsx#Users"]);
  });

  it("fires on the async/await inner-function pattern", () => {
    const graph = buildStateGraph([
      {
        path: "profile.tsx",
        code: `
          function Profile() {
            const [profile, setProfile] = useState(null);
            useEffect(() => {
              async function load() {
                const res = await fetch('/api/me');
                setProfile(await res.json());
              }
              load();
            }, []);
            return <div>{profile?.name}</div>;
          }
        `,
      },
    ]);
    expect(detectServerStateInClientState(graph)).toHaveLength(1);
  });

  it("fires on axios calls", () => {
    const graph = buildStateGraph([
      {
        path: "orders.tsx",
        code: `
          function Orders() {
            const [orders, setOrders] = useState([]);
            useEffect(() => {
              axios.get('/api/orders').then((res) => setOrders(res.data));
            }, []);
            return <span>{orders.length}</span>;
          }
        `,
      },
    ]);
    expect(detectServerStateInClientState(graph)).toHaveLength(1);
  });

  it("stays quiet for non-async effects that set state", () => {
    const graph = buildStateGraph([
      {
        path: "timer.tsx",
        code: `
          function Timer() {
            const [ticks, setTicks] = useState(0);
            useEffect(() => {
              const id = setInterval(() => setTicks((t) => t + 1), 1000);
              return () => clearInterval(id);
            }, []);
            return <span>{ticks}</span>;
          }
        `,
      },
    ]);
    expect(detectServerStateInClientState(graph)).toHaveLength(0);
  });

  it("only reclassifies the state the async effect actually feeds", () => {
    const graph = buildStateGraph([
      {
        path: "mixed.tsx",
        code: `
          function Dashboard() {
            const [stats, setStats] = useState(null);
            const [tab, setTab] = useState('overview');
            useEffect(() => {
              fetch('/api/stats').then((r) => r.json()).then(setStats);
            }, []);
            return <div onClick={() => setTab('detail')}>{tab}{stats?.total}</div>;
          }
        `,
      },
    ]);
    const findings = detectServerStateInClientState(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("'stats'");
    expect(graph.sourcesOf("local").map((s) => s.name)).toEqual(["tab"]);
  });
});
