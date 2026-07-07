import { describe, expect, it } from "vitest";
import { buildStateGraph } from "../graph/build.js";
import { detectDefeatedMemo } from "./defeated-memo.js";
import { detectDerivedStateAsState } from "./derived-state.js";
import { detectPointlessMemo } from "./pointless-memo.js";

describe("detectDerivedStateAsState", () => {
  it("flags useState recomputed from other state by a sync effect", () => {
    const graph = buildStateGraph([
      {
        path: "src/Name.tsx",
        code: `
          export function Name({ first, last }) {
            const [fullName, setFullName] = useState('');
            useEffect(() => {
              setFullName(first + ' ' + last);
            }, [first, last]);
            return <h1>{fullName}</h1>;
          }
        `,
      },
    ]);
    const findings = detectDerivedStateAsState(graph);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.rule).toBe("derived-state-as-state");
    expect(finding.message).toContain("'fullName'");
    expect(finding.message).toContain("renders twice");
    expect(finding.recommendation).toContain("useMemo");
  });

  it("does not flag timer/subscription callbacks (setInterval)", () => {
    const graph = buildStateGraph([
      {
        path: "src/Timer.tsx",
        code: `
          export function Timer() {
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
    expect(detectDerivedStateAsState(graph)).toHaveLength(0);
  });

  it("does not flag state also set by event handlers (not purely derived)", () => {
    const graph = buildStateGraph([
      {
        path: "src/Filtered.tsx",
        code: `
          export function Filtered({ items }) {
            const [visible, setVisible] = useState([]);
            useEffect(() => {
              setVisible(items.filter((i) => i.active));
            }, [items]);
            return <button onClick={() => setVisible([])}>{visible.length}</button>;
          }
        `,
      },
    ]);
    expect(detectDerivedStateAsState(graph)).toHaveLength(0);
  });

  it("leaves async-fed state to server-state-in-client-state", () => {
    const graph = buildStateGraph([
      {
        path: "src/Users.tsx",
        code: `
          export function Users() {
            const [users, setUsers] = useState([]);
            useEffect(() => {
              fetch('/api/users').then((r) => r.json()).then(setUsers);
            }, []);
            return <ul>{users.length}</ul>;
          }
        `,
      },
    ]);
    expect(detectDerivedStateAsState(graph)).toHaveLength(0);
  });
});

describe("detectDefeatedMemo", () => {
  it("flags memo components receiving inline literal props", () => {
    const graph = buildStateGraph([
      {
        path: "src/app.tsx",
        code: `
          import { memo } from 'react';
          const Row = memo(({ style, onPick }) => (
            <div style={style} onClick={onPick} />
          ));
          export function List({ items }) {
            return <Row style={{ padding: 8 }} onPick={() => select(1)} />;
          }
        `,
      },
    ]);
    const findings = detectDefeatedMemo(graph);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.rule).toBe("defeated-memo");
    expect(finding.message).toContain("Row");
    expect(finding.message).toContain("'style'");
    expect(finding.message).toContain("'onPick'");
    expect(finding.message).toContain("never skips");
  });

  it("stays quiet for stable references and non-memo components", () => {
    const graph = buildStateGraph([
      {
        path: "src/app.tsx",
        code: `
          import { memo } from 'react';
          const Stable = memo(({ config }) => <div>{config.mode}</div>);
          const Plain = ({ style }) => <div style={style} />;
          const CONFIG = { mode: 'a' };
          export function App() {
            return (
              <>
                <Stable config={CONFIG} />
                <Plain style={{ padding: 8 }} />
              </>
            );
          }
        `,
      },
    ]);
    expect(detectDefeatedMemo(graph)).toHaveLength(0);
  });
});

describe("detectPointlessMemo", () => {
  it("flags useMemo without a dependency array", () => {
    const graph = buildStateGraph([
      {
        path: "src/app.tsx",
        code: `
          export function App({ items }) {
            const sorted = useMemo(() => [...items].sort());
            return <ul>{sorted.length}</ul>;
          }
        `,
      },
    ]);
    const findings = detectPointlessMemo(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("no dependency array");
    expect(findings[0]!.message).toContain("App");
  });

  it("flags inline literals inside the deps array, including in hooks", () => {
    const graph = buildStateGraph([
      {
        path: "src/useSorted.ts",
        code: `
          export function useSorted(items) {
            return useMemo(() => [...items].sort(), [items, { locale: 'en' }]);
          }
        `,
      },
    ]);
    const findings = detectPointlessMemo(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("useSorted");
    expect(findings[0]!.message).toContain("cache never hits");
  });

  it("stays quiet for correct memoization", () => {
    const graph = buildStateGraph([
      {
        path: "src/app.tsx",
        code: `
          export function App({ items, mode }) {
            const sorted = useMemo(() => [...items].sort(), [items]);
            const pick = useCallback((id) => select(id, mode), [mode]);
            return <ul onClick={pick}>{sorted.length}</ul>;
          }
        `,
      },
    ]);
    expect(detectPointlessMemo(graph)).toHaveLength(0);
  });
});
