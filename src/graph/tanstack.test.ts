import { describe, expect, it } from "vitest";
import { buildStateGraph } from "./build.js";
import { detectMultipleSourcesOfTruth } from "../detectors/multiple-sources.js";

describe("tanstack query adapter", () => {
  it("registers useQuery (v5 object form) as a server-cache source keyed by query key", () => {
    const graph = buildStateGraph([
      {
        path: "src/Todos.tsx",
        code: `
          import { useQuery } from '@tanstack/react-query';
          export function Todos() {
            const { data } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos });
            return <ul>{data?.length}</ul>;
          }
        `,
      },
    ]);

    const source = graph.sources.get("query:todos");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("tanstack-query");
    expect(source?.classification).toBe("server-cache");
    expect(source?.name).toBe("todos");
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/Todos.tsx#Todos",
      to: "query:todos",
      via: "hook",
    });
  });

  it("supports the v4 positional form and shares identity across call sites", () => {
    const graph = buildStateGraph([
      {
        path: "src/A.tsx",
        code: `
          import { useQuery } from 'react-query';
          export function A() {
            const { data } = useQuery(['user'], fetchUser);
            return <span>{data?.name}</span>;
          }
        `,
      },
      {
        path: "src/B.tsx",
        code: `
          import { useQuery } from 'react-query';
          export function B() {
            const { data } = useQuery(['user'], fetchUser);
            return <img src={data?.avatar} />;
          }
        `,
      },
    ]);

    // ONE source (the cache entry), TWO readers.
    const querySources = [...graph.sources.values()].filter(
      (s) => s.kind === "tanstack-query",
    );
    expect(querySources).toHaveLength(1);
    const readers = graph.edges
      .filter((e) => e.type === "reads" && e.to === "query:user")
      .map((e) => e.from)
      .sort();
    expect(readers).toEqual(["src/A.tsx#A", "src/B.tsx#B"]);
  });

  it("attributes queries through custom hooks (useTodos → useQuery)", () => {
    const graph = buildStateGraph([
      {
        path: "src/useTodos.ts",
        code: `
          import { useQuery } from '@tanstack/react-query';
          export function useTodos() {
            return useQuery({ queryKey: ['todos'], queryFn: fetchTodos });
          }
        `,
      },
      {
        path: "src/List.tsx",
        code: `
          import { useTodos } from './useTodos';
          export function List() {
            const { data } = useTodos();
            return <ul>{data?.length}</ul>;
          }
        `,
      },
    ]);
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/List.tsx#List",
      to: "query:todos",
      via: "hook",
    });
  });

  it("ignores useQuery from other libraries and dynamic keys", () => {
    const graph = buildStateGraph([
      {
        path: "src/Other.tsx",
        code: `
          import { useQuery } from 'urql';
          export function Other() {
            const [result] = useQuery({ query: SomeDoc });
            return <div>{result.fetching}</div>;
          }
        `,
      },
      {
        path: "src/Dynamic.tsx",
        code: `
          import { useQuery } from '@tanstack/react-query';
          export function Dynamic({ id }) {
            const { data } = useQuery({ queryKey: [id], queryFn: () => fetchItem(id) });
            return <div>{data?.name}</div>;
          }
        `,
      },
    ]);
    expect(
      [...graph.sources.values()].some((s) => s.kind === "tanstack-query"),
    ).toBe(false);
  });
});

describe("multiple-sources-of-truth — duplicated server caches", () => {
  it("flags a query plus a hand-rolled fetch cache for the same entity", () => {
    const graph = buildStateGraph([
      {
        path: "src/Profile.tsx",
        code: `
          import { useQuery } from '@tanstack/react-query';
          export function Profile() {
            const { data } = useQuery({ queryKey: ['user'], queryFn: fetchUser });
            return <span>{data?.name}</span>;
          }
        `,
      },
      {
        path: "src/Header.tsx",
        code: `
          export function Header() {
            const [user, setUser] = useState(null);
            useEffect(() => {
              fetch('/api/me').then((r) => r.json()).then(setUser);
            }, []);
            return <img src={user?.avatar} />;
          }
        `,
      },
    ]);

    const findings = detectMultipleSourcesOfTruth(graph);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.message).toContain("Server entity 'user'");
    expect(finding.message).toContain("query 'user'");
    expect(finding.message).toContain("useState 'user'");
    expect(finding.recommendation).toContain("existing query");
  });

  it("flags two hand-rolled caches even without a query", () => {
    const fetchComponent = (name: string) => `
      export function ${name}() {
        const [orders, setOrders] = useState([]);
        useEffect(() => {
          fetch('/api/orders').then((r) => r.json()).then(setOrders);
        }, []);
        return <ul>{orders.length}</ul>;
      }
    `;
    const graph = buildStateGraph([
      { path: "src/OrdersPage.tsx", code: fetchComponent("OrdersPage") },
      { path: "src/OrdersWidget.tsx", code: fetchComponent("OrdersWidget") },
    ]);

    const findings = detectMultipleSourcesOfTruth(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("Server entity 'orders'");
    expect(findings[0]!.recommendation).toContain("TanStack Query");
  });

  it("does not flag a single well-placed query", () => {
    const graph = buildStateGraph([
      {
        path: "src/Todos.tsx",
        code: `
          import { useQuery } from '@tanstack/react-query';
          export function Todos() {
            const { data } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos });
            return <ul>{data?.length}</ul>;
          }
        `,
      },
    ]);
    expect(detectMultipleSourcesOfTruth(graph)).toHaveLength(0);
  });
});
