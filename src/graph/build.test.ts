import { describe, expect, it } from "vitest";
import { buildStateGraph } from "./build.js";

/**
 * The canonical prop-drill fixture:
 *   Grandparent declares `user` state, writes it in a handler,
 *   drills it through Parent (forward-only) down to Child (real read).
 */
const DRILL_FIXTURE = `
import { useState } from 'react';

function Grandparent() {
  const [user, setUser] = useState({ name: 'Ada' });
  const save = () => setUser({ name: 'Grace' });
  return <Parent user={user} onSave={save} />;
}

function Parent({ user, onSave }) {
  return <Child user={user} />;
}

function Child({ user }) {
  return <span>{user.name}</span>;
}
`;

function drillGraph() {
  return buildStateGraph([{ path: "app.tsx", code: DRILL_FIXTURE }]);
}

describe("buildStateGraph — components", () => {
  it("finds all function components", () => {
    const graph = drillGraph();
    const names = [...graph.components.values()].map((c) => c.name).sort();
    expect(names).toEqual(["Child", "Grandparent", "Parent"]);
  });

  it("detects React.memo wrapping", () => {
    const graph = buildStateGraph([
      {
        path: "memo.tsx",
        code: `
          import { memo } from 'react';
          const Plain = () => <div />;
          const Wrapped = memo(({ label }) => <span>{label}</span>);
        `,
      },
    ]);
    const byName = new Map(
      [...graph.components.values()].map((c) => [c.name, c]),
    );
    expect(byName.get("Plain")?.isMemo).toBe(false);
    expect(byName.get("Wrapped")?.isMemo).toBe(true);
  });
});

describe("buildStateGraph — state sources", () => {
  it("registers useState with owner, kind, and local classification", () => {
    const graph = drillGraph();
    expect(graph.sources.size).toBe(1);
    const source = [...graph.sources.values()][0]!;
    expect(source.name).toBe("user");
    expect(source.kind).toBe("useState");
    expect(source.classification).toBe("local");
    expect(source.ownerComponentId).toBe("app.tsx#Grandparent");
  });

  it("registers useReducer sources", () => {
    const graph = buildStateGraph([
      {
        path: "reducer.tsx",
        code: `
          function Cart() {
            const [items, dispatch] = useReducer(cartReducer, []);
            return <button onClick={() => dispatch({ type: 'clear' })}>{items.length}</button>;
          }
        `,
      },
    ]);
    const source = [...graph.sources.values()][0]!;
    expect(source.kind).toBe("useReducer");
    expect(source.name).toBe("items");
  });
});

describe("buildStateGraph — edges", () => {
  it("creates declares, reads, and writes edges for the owner", () => {
    const graph = drillGraph();
    const stateId = "app.tsx#Grandparent.user";
    const owner = "app.tsx#Grandparent";

    expect(graph.edges).toContainEqual({
      type: "declares",
      from: owner,
      to: stateId,
    });
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: owner,
      to: stateId,
      via: "hook",
    });
    expect(graph.edges).toContainEqual({
      type: "writes",
      from: owner,
      to: stateId,
      via: "setter",
    });
  });

  it("does not emit a writes edge when the setter is never called", () => {
    const graph = buildStateGraph([
      {
        path: "nowrite.tsx",
        code: `
          function Viewer() {
            const [value, setValue] = useState(0);
            return <span>{value}</span>;
          }
        `,
      },
    ]);
    expect(graph.edges.some((e) => e.type === "writes")).toBe(false);
  });
});

describe("buildStateGraph — prop drilling (passesProp)", () => {
  it("marks forward-only intermediates as reads:false and real consumers as reads:true", () => {
    const graph = drillGraph();
    const passes = graph.edges.filter(
      (e) => e.type === "passesProp" && e.prop === "user",
    );

    const toParent = passes.find(
      (e) => e.type === "passesProp" && e.to === "app.tsx#Parent",
    );
    const toChild = passes.find(
      (e) => e.type === "passesProp" && e.to === "app.tsx#Child",
    );

    expect(toParent).toBeDefined();
    expect(toChild).toBeDefined();
    if (toParent?.type === "passesProp") expect(toParent.reads).toBe(false);
    if (toChild?.type === "passesProp") expect(toChild.reads).toBe(true);
  });

  it("marks unused props as reads:false", () => {
    const graph = drillGraph();
    const onSave = graph.edges.find(
      (e) => e.type === "passesProp" && e.prop === "onSave",
    );
    expect(onSave).toBeDefined();
    if (onSave?.type === "passesProp") expect(onSave.reads).toBe(false);
  });

  it("treats passing a prop to a DOM element as a real read", () => {
    const graph = buildStateGraph([
      {
        path: "dom.tsx",
        code: `
          function Form() {
            const [name, setName] = useState('');
            return <Field name={name} />;
          }
          function Field({ name }) {
            return <input value={name} />;
          }
        `,
      },
    ]);
    const edge = graph.edges.find(
      (e) => e.type === "passesProp" && e.prop === "name",
    );
    expect(edge).toBeDefined();
    if (edge?.type === "passesProp") expect(edge.reads).toBe(true);
  });

  it("handles (props) parameter style", () => {
    const graph = buildStateGraph([
      {
        path: "props.tsx",
        code: `
          function App() {
            const [theme, setTheme] = useState('dark');
            return <Panel theme={theme} />;
          }
          function Panel(props) {
            return <div className={props.theme} />;
          }
        `,
      },
    ]);
    const edge = graph.edges.find(
      (e) => e.type === "passesProp" && e.prop === "theme",
    );
    expect(edge).toBeDefined();
    if (edge?.type === "passesProp") expect(edge.reads).toBe(true);
  });
});

describe("StateGraph query API", () => {
  it("readsOf returns read edges for a source", () => {
    const graph = drillGraph();
    const reads = graph.readsOf("app.tsx#Grandparent.user");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.from).toBe("app.tsx#Grandparent");
  });

  it("sourcesOf filters by classification", () => {
    const graph = drillGraph();
    expect(graph.sourcesOf("local")).toHaveLength(1);
    expect(graph.sourcesOf("server-cache")).toHaveLength(0);
  });

  it("propChain walks the full drill path", () => {
    const graph = drillGraph();
    const chain = graph.propChain("app.tsx#Grandparent", "user");
    expect(chain).toHaveLength(2);
    expect(chain.map((e) => e.to)).toEqual(["app.tsx#Parent", "app.tsx#Child"]);
  });
});
