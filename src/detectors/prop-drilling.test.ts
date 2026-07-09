import { describe, expect, it } from "vitest";
import { buildStateGraph } from "../graph/build.js";
import { detectPropDrilling } from "./prop-drilling.js";

/** 4-level drill: user passes through TWO blind intermediates before the real consumer. */
const DEEP_DRILL = `
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
`;

/** 3-level: only ONE blind intermediate (Parent). */
const SHALLOW_DRILL = `
function App() {
  const [user, setUser] = useState({ name: 'Ada' });
  return <Parent user={user} />;
}
function Parent({ user }) {
  return <Child user={user} />;
}
function Child({ user }) {
  return <span>{user.name}</span>;
}
`;

/** Intermediate that ALSO reads the prop — not blind, not drilling. */
const READING_CHAIN = `
function App() {
  const [user, setUser] = useState({ name: 'Ada' });
  return <Header user={user} />;
}
function Header({ user }) {
  return (
    <div title={user.name}>
      <Avatar user={user} />
    </div>
  );
}
function Avatar({ user }) {
  return <img alt={user.name} />;
}
`;

/** A prop drilled from ALREADY-SHARED state (context) — origin reads it via useContext. */
const CONTEXT_DRILL = [
  {
    path: "theme.tsx",
    code: `import { createContext } from 'react';
      export const ThemeContext = createContext('light');`,
  },
  {
    path: "Dashboard.tsx",
    code: `import { useContext } from 'react';
      import { ThemeContext } from './theme';
      import { Row } from './Row';
      export function Dashboard() {
        const theme = useContext(ThemeContext);
        return <Row theme={theme} />;
      }`,
  },
  {
    path: "Row.tsx",
    code: `import { Cell } from './Cell';
      export function Row({ theme }) { return <Cell theme={theme} />; }`,
  },
  {
    path: "Cell.tsx",
    code: `import { Badge } from './Badge';
      export function Cell({ theme }) { return <Badge theme={theme} />; }`,
  },
  {
    path: "Badge.tsx",
    code: `export function Badge({ theme }) { return <span className={theme} />; }`,
  },
];

/** Origin holds no tracked state — the prop's class can't be resolved. */
const UNKNOWN_DRILL = `
function Widget() {
  const label = greet();
  return <A x={label} />;
}
function A({ x }) { return <B x={x} />; }
function B({ x }) { return <C x={x} />; }
function C({ x }) { return <span>{x}</span>; }
`;

describe("detectPropDrilling", () => {
  it("fires on a chain with 2+ blind intermediates", () => {
    const graph = buildStateGraph([{ path: "app.tsx", code: DEEP_DRILL }]);
    const findings = detectPropDrilling(graph);

    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.rule).toBe("prop-drilling");
    expect(finding.message).toContain("'user'");
    expect(finding.message).toContain("Layout → Sidebar");
    expect(finding.message).toContain("Profile");
    expect(finding.path).toEqual([
      "app.tsx#App",
      "app.tsx#Layout",
      "app.tsx#Sidebar",
      "app.tsx#Profile",
    ]);
  });

  it("stays quiet below the threshold by default", () => {
    const graph = buildStateGraph([{ path: "app.tsx", code: SHALLOW_DRILL }]);
    expect(detectPropDrilling(graph)).toHaveLength(0);
  });

  it("fires on shallow chains when the threshold is lowered", () => {
    const graph = buildStateGraph([{ path: "app.tsx", code: SHALLOW_DRILL }]);
    const findings = detectPropDrilling(graph, { minBlindIntermediates: 1 });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("Parent");
  });

  it("does not flag intermediates that genuinely read the prop", () => {
    const graph = buildStateGraph([{ path: "app.tsx", code: READING_CHAIN }]);
    expect(
      detectPropDrilling(graph, { minBlindIntermediates: 1 }),
    ).toHaveLength(0);
  });

  it("drops to info when the drilled prop is already-shared state", () => {
    const graph = buildStateGraph(CONTEXT_DRILL);
    const findings = detectPropDrilling(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("info");
  });

  it("keeps warn when the drilled prop is genuinely local state", () => {
    const graph = buildStateGraph([{ path: "app.tsx", code: DEEP_DRILL }]);
    expect(detectPropDrilling(graph)[0]!.severity).toBe("warn");
  });

  it("recommends reading at the leaf when the prop is already-shared", () => {
    const graph = buildStateGraph(CONTEXT_DRILL);
    const rec = detectPropDrilling(graph)[0]!.recommendation;
    expect(rec).toMatch(/read.*directly|at the leaf/i);
    expect(rec).toContain("Badge"); // the leaf consumer
    expect(rec).not.toMatch(/move this state to context/i);
  });

  it("recommends composition when the prop is genuinely local state", () => {
    const graph = buildStateGraph([{ path: "app.tsx", code: DEEP_DRILL }]);
    const rec = detectPropDrilling(graph)[0]!.recommendation;
    expect(rec).toMatch(/child|compos/i);
  });

  it("gives a conditional rec when the origin class is unknown", () => {
    const graph = buildStateGraph([{ path: "app.tsx", code: UNKNOWN_DRILL }]);
    const rec = detectPropDrilling(graph, { minBlindIntermediates: 1 })[0]!
      .recommendation;
    expect(rec).toMatch(/if .*shared/i);
  });

  it("describes intermediates as forwarding, not as failing to read", () => {
    const graph = buildStateGraph([{ path: "app.tsx", code: DEEP_DRILL }]);
    const msg = detectPropDrilling(graph)[0]!.message;
    expect(msg).toMatch(/only forward/i);
    expect(msg).not.toMatch(/never read it/i);
  });

  it("every finding carries a recommendation", () => {
    const graph = buildStateGraph([{ path: "app.tsx", code: DEEP_DRILL }]);
    for (const finding of detectPropDrilling(graph)) {
      expect(finding.recommendation.length).toBeGreaterThan(0);
    }
  });
});
