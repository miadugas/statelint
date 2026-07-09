import { describe, expect, it } from "vitest";
import { buildStateGraph } from "./build.js";
import { detectOverGlobalizedState } from "../detectors/over-globalized.js";
import { detectPropDrilling } from "../detectors/prop-drilling.js";

describe("cross-file resolution", () => {
  it("resolves a drill chain across three files (default + named imports)", () => {
    const graph = buildStateGraph([
      {
        path: "src/App.tsx",
        code: `
          import Layout from './Layout';
          export function App() {
            const [user, setUser] = useState({ name: 'Ada' });
            return <Layout user={user} />;
          }
        `,
      },
      {
        path: "src/Layout.tsx",
        code: `
          import { Profile } from './widgets/Profile';
          export default function Layout({ user }) {
            return <Profile user={user} />;
          }
        `,
      },
      {
        path: "src/widgets/Profile.tsx",
        code: `
          export function Profile({ user }) {
            return <h1>{user.name}</h1>;
          }
        `,
      },
    ]);

    const chain = graph.propChain("src/App.tsx#App", "user");
    expect(chain.map((e) => e.to)).toEqual([
      "src/Layout.tsx#Layout",
      "src/widgets/Profile.tsx#Profile",
    ]);

    const findings = detectPropDrilling(graph, { minBlindIntermediates: 1 });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("Layout");
  });

  it("resolves aliased imports (import { Panel as SidePanel })", () => {
    const graph = buildStateGraph([
      {
        path: "src/App.tsx",
        code: `
          import { Panel as SidePanel } from './Panel';
          export function App() {
            const [width, setWidth] = useState(240);
            return <SidePanel width={width} />;
          }
        `,
      },
      {
        path: "src/Panel.tsx",
        code: `
          export function Panel({ width }) {
            return <aside style={{ width }} />;
          }
        `,
      },
    ]);
    const edge = graph.edges.find(
      (e) => e.type === "passesProp" && e.prop === "width",
    );
    expect(edge).toBeDefined();
    if (edge?.type === "passesProp") {
      expect(edge.to).toBe("src/Panel.tsx#Panel");
      expect(edge.reads).toBe(true);
    }
  });

  it("keeps same-named components in different files separate", () => {
    const graph = buildStateGraph([
      {
        path: "src/a.tsx",
        code: `
          function Item({ label }) {
            return <li>{label}</li>;
          }
          export function ListA() {
            const [label, setLabel] = useState('a');
            return <Item label={label} />;
          }
        `,
      },
      {
        path: "src/b.tsx",
        code: `
          function Item({ label }) {
            return <li />;
          }
          export function ListB() {
            const [label, setLabel] = useState('b');
            return <Item label={label} />;
          }
        `,
      },
    ]);

    // Both Items exist as distinct nodes…
    expect(graph.components.has("src/a.tsx#Item")).toBe(true);
    expect(graph.components.has("src/b.tsx#Item")).toBe(true);

    // …and each file's pass resolves to ITS OWN Item: a reads, b doesn't.
    const passes = graph.edges.filter(
      (e) => e.type === "passesProp" && e.prop === "label",
    );
    const toA = passes.find(
      (e) => e.type === "passesProp" && e.to === "src/a.tsx#Item",
    );
    const toB = passes.find(
      (e) => e.type === "passesProp" && e.to === "src/b.tsx#Item",
    );
    if (toA?.type === "passesProp") expect(toA.reads).toBe(true);
    if (toB?.type === "passesProp") expect(toB.reads).toBe(false);
    expect(toA).toBeDefined();
    expect(toB).toBeDefined();
  });

  it("resolves index-file imports (./widgets → ./widgets/index.tsx)", () => {
    const graph = buildStateGraph([
      {
        path: "src/App.tsx",
        code: `
          import { Card } from './widgets';
          export function App() {
            const [title, setTitle] = useState('hi');
            return <Card title={title} />;
          }
        `,
      },
      {
        path: "src/widgets/index.tsx",
        code: `
          export function Card({ title }) {
            return <h2>{title}</h2>;
          }
        `,
      },
    ]);
    const edge = graph.edges.find(
      (e) => e.type === "passesProp" && e.prop === "title",
    );
    expect(edge).toBeDefined();
    if (edge?.type === "passesProp")
      expect(edge.to).toBe("src/widgets/index.tsx#Card");
  });

  it("resolves .js module imports (CRA-era context consumed through a wrapper hook)", () => {
    const graph = buildStateGraph([
      {
        path: "src/context.js",
        code: `
          import React, { createContext, useContext, useState } from 'react';
          const GlobalContext = createContext();
          export function AppProvider({ children }) {
            const [stories, setStories] = useState([]);
            return (
              <GlobalContext.Provider value={{ stories, setStories }}>
                {children}
              </GlobalContext.Provider>
            );
          }
          export function useGlobalContext() {
            return useContext(GlobalContext);
          }
        `,
      },
      {
        path: "src/Stories.js",
        code: `
          import { useGlobalContext } from './context';
          export function Stories() {
            const { stories } = useGlobalContext();
            return <div>{stories.length}</div>;
          }
        `,
      },
    ]);

    // The hook's useContext read must attribute to the Stories component —
    // this only works when './context' resolves to context.js.
    const consumes = graph.edges.find(
      (e) =>
        e.type === "consumes" &&
        e.from === "src/Stories.js#Stories" &&
        e.to === "src/context.js#GlobalContext",
    );
    expect(consumes).toBeDefined();

    // With the consumption visible, the false "never consumed" info must not fire.
    const findings = detectOverGlobalizedState(graph);
    expect(
      findings.filter((f) => f.message.includes("never consumed")),
    ).toHaveLength(0);
  });

  it("ignores package imports without crashing", () => {
    const graph = buildStateGraph([
      {
        path: "src/App.tsx",
        code: `
          import { Route } from 'react-router';
          export function App() {
            const [path, setPath] = useState('/');
            return <Route path={path} />;
          }
        `,
      },
    ]);
    expect(graph.edges.some((e) => e.type === "passesProp")).toBe(false);
  });
});
