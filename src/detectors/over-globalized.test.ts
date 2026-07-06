import { describe, expect, it } from "vitest";
import { buildStateGraph } from "../graph/build.js";
import { detectOverGlobalizedState } from "./over-globalized.js";

describe("detectOverGlobalizedState", () => {
  it("warns when a provided context has exactly one consumer", () => {
    const graph = buildStateGraph([
      {
        path: "src/app.tsx",
        code: `
          const FilterContext = createContext(null);
          export function App() {
            const [filter, setFilter] = useState('all');
            return (
              <FilterContext.Provider value={filter}>
                <Page />
              </FilterContext.Provider>
            );
          }
          function Page() {
            return <TodoList />;
          }
          function TodoList() {
            const filter = useContext(FilterContext);
            return <ul data-filter={filter} />;
          }
        `,
      },
    ]);

    const findings = detectOverGlobalizedState(graph);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.rule).toBe("over-globalized-state");
    expect(finding.severity).toBe("warn");
    expect(finding.message).toContain("'FilterContext'");
    expect(finding.message).toContain("TodoList");
    expect(finding.recommendation).toContain("Colocate");
  });

  it("stays quiet with two or more consumers", () => {
    const graph = buildStateGraph([
      {
        path: "src/app.tsx",
        code: `
          const ThemeContext = createContext('light');
          export function App() {
            return (
              <ThemeContext.Provider value="dark">
                <Nav />
                <Footer />
              </ThemeContext.Provider>
            );
          }
          function Nav() {
            const theme = useContext(ThemeContext);
            return <nav className={theme} />;
          }
          function Footer() {
            const theme = useContext(ThemeContext);
            return <footer className={theme} />;
          }
        `,
      },
    ]);
    expect(detectOverGlobalizedState(graph)).toHaveLength(0);
  });

  it("reports a provided-but-never-consumed context as info", () => {
    const graph = buildStateGraph([
      {
        path: "src/app.tsx",
        code: `
          const DeadContext = createContext(null);
          export function App() {
            return (
              <DeadContext.Provider value={42}>
                <Main />
              </DeadContext.Provider>
            );
          }
          function Main() {
            return <div />;
          }
        `,
      },
    ]);
    const findings = detectOverGlobalizedState(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("info");
    expect(findings[0]!.message).toContain("never consumed");
  });

  it("ignores contexts that are declared but never provided", () => {
    const graph = buildStateGraph([
      {
        path: "src/lib.tsx",
        code: `
          export const LibContext = createContext(null);
          export function useLib() {
            return useContext(LibContext);
          }
        `,
      },
    ]);
    expect(detectOverGlobalizedState(graph)).toHaveLength(0);
  });
});
