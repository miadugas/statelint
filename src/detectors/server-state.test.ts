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

  it("groups fields fed by one effect into a single finding", () => {
    const graph = buildStateGraph([
      {
        path: "form.tsx",
        code: `
          function Prefill() {
            const [firstName, setFirstName] = useState('');
            const [lastName, setLastName] = useState('');
            const [email, setEmail] = useState('');
            useEffect(() => {
              fetch('/api/me')
                .then((r) => r.json())
                .then((d) => {
                  setFirstName(d.firstName);
                  setLastName(d.lastName);
                  setEmail(d.email);
                });
            }, []);
            return <span>{firstName} {lastName} {email}</span>;
          }
        `,
      },
    ]);
    const findings = detectServerStateInClientState(graph);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.message).toContain("3");
    expect(finding.message).toContain("'firstName'");
    expect(finding.message).toContain("'lastName'");
    expect(finding.message).toContain("'email'");
  });

  it("softens to info when every fed field is also user-edited (prefilled draft)", () => {
    const graph = buildStateGraph([
      {
        path: "draft.tsx",
        code: `
          function EditProfile() {
            const [name, setName] = useState('');
            useEffect(() => {
              fetch('/api/me').then((r) => r.json()).then((d) => setName(d.name));
            }, []);
            return <input value={name} onChange={(e) => setName(e.target.value)} />;
          }
        `,
      },
    ]);
    const findings = detectServerStateInClientState(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("info");
    expect(findings[0]!.message).toContain("draft");
    expect(findings[0]!.recommendation).toContain("useQuery");
  });

  it("keeps warn severity when only some fed fields are user-edited", () => {
    const graph = buildStateGraph([
      {
        path: "mixed-draft.tsx",
        code: `
          function Account() {
            const [name, setName] = useState('');
            const [plan, setPlan] = useState(null);
            useEffect(() => {
              fetch('/api/account')
                .then((r) => r.json())
                .then((d) => {
                  setName(d.name);
                  setPlan(d.plan);
                });
            }, []);
            return <input value={name} onChange={(e) => setName(e.target.value)} title={plan} />;
          }
        `,
      },
    ]);
    const findings = detectServerStateInClientState(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warn");
    expect(findings[0]!.message).toContain("'name'");
    expect(findings[0]!.message).toContain("also user-edited");
  });

  it("emits one finding per distinct effect", () => {
    const graph = buildStateGraph([
      {
        path: "two-effects.tsx",
        code: `
          function Dashboard() {
            const [stats, setStats] = useState(null);
            const [alerts, setAlerts] = useState([]);
            useEffect(() => {
              fetch('/api/stats').then((r) => r.json()).then(setStats);
            }, []);
            useEffect(() => {
              fetch('/api/alerts').then((r) => r.json()).then(setAlerts);
            }, []);
            return <div>{stats?.total}{alerts.length}</div>;
          }
        `,
      },
    ]);
    expect(detectServerStateInClientState(graph)).toHaveLength(2);
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
