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

  it("every finding carries a recommendation", () => {
    const graph = buildStateGraph([{ path: "app.tsx", code: DEEP_DRILL }]);
    for (const finding of detectPropDrilling(graph)) {
      expect(finding.recommendation.length).toBeGreaterThan(0);
    }
  });
});
