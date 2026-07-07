import { describe, expect, it } from "vitest";
import { buildStateGraph } from "../graph/build.js";
import { computeStackProfile } from "./stack.js";
import { detectServerStateInClientState } from "./server-state.js";
import { detectStorageAsState } from "./storage-as-state.js";

const FETCH_CACHE = `
  export function Users() {
    const [users, setUsers] = useState([]);
    useEffect(() => {
      fetch('/api/users').then((r) => r.json()).then(setUsers);
    }, []);
    return <ul>{users.length}</ul>;
  }
`;

describe("computeStackProfile", () => {
  it("detects a TanStack-dominant app", () => {
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
    expect(computeStackProfile(graph).serverLib).toBe("TanStack Query");
  });

  it("detects an RTK-Query-dominant app", () => {
    const graph = buildStateGraph([
      {
        path: "src/api.ts",
        code: `
          import { createApi } from '@reduxjs/toolkit/query/react';
          export const api = createApi({
            endpoints: (b) => ({
              getUser: b.query({ query: () => '/me' }),
              getOrders: b.query({ query: () => '/orders' }),
            }),
          });
        `,
      },
      {
        path: "src/Profile.tsx",
        code: `
          import { useGetUserQuery } from './api';
          export function Profile() {
            const { data } = useGetUserQuery();
            return <span>{data?.name}</span>;
          }
        `,
      },
    ]);
    expect(computeStackProfile(graph).serverLib).toBe("RTK Query");
  });

  it("returns null when the app uses neither", () => {
    const graph = buildStateGraph([
      { path: "src/Users.tsx", code: FETCH_CACHE },
    ]);
    expect(computeStackProfile(graph).serverLib).toBeNull();
  });
});

describe("stack-aware recommendations", () => {
  it("recommends only TanStack in a TanStack app — RTK never mentioned", () => {
    const graph = buildStateGraph([
      { path: "src/Users.tsx", code: FETCH_CACHE },
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
    const profile = computeStackProfile(graph);
    const findings = detectServerStateInClientState(graph, profile);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.recommendation).toContain("TanStack Query");
    expect(findings[0]!.recommendation).toContain("already uses it");
    expect(findings[0]!.recommendation).not.toContain("RTK");
  });

  it("recommends RTK Query in an RTK-dominant app", () => {
    const graph = buildStateGraph([
      { path: "src/Users.tsx", code: FETCH_CACHE },
      {
        path: "src/api.ts",
        code: `
          import { createApi } from '@reduxjs/toolkit/query/react';
          export const api = createApi({
            endpoints: (b) => ({ getUser: b.query({ query: () => '/me' }) }),
          });
        `,
      },
      {
        path: "src/Profile.tsx",
        code: `
          import { useGetUserQuery } from './api';
          export function Profile() {
            const { data } = useGetUserQuery();
            return <span>{data?.name}</span>;
          }
        `,
      },
    ]);
    const profile = computeStackProfile(graph);
    const findings = detectServerStateInClientState(graph, profile);
    expect(findings[0]!.recommendation).toContain("RTK Query");
    expect(findings[0]!.recommendation).not.toContain("TanStack");
  });

  it("recommends a generic query library when the app has neither", () => {
    const graph = buildStateGraph([
      { path: "src/Users.tsx", code: FETCH_CACHE },
    ]);
    const findings = detectServerStateInClientState(
      graph,
      computeStackProfile(graph),
    );
    expect(findings[0]!.recommendation).toContain("a query library");
  });

  it("points storage-as-state at the app's dominant store", () => {
    const graph = buildStateGraph([
      {
        path: "src/cartStore.ts",
        code: `
          import { create } from 'zustand';
          export const useCartStore = create(() => ({ items: [] }));
        `,
      },
      {
        path: "src/A.tsx",
        code: `
          import { useCartStore } from './cartStore';
          export function A() {
            const items = useCartStore((s) => s.items);
            return <span onClick={() => localStorage.setItem('draft', 'x')}>{items.length}</span>;
          }
        `,
      },
      {
        path: "src/B.tsx",
        code: `
          export function B() {
            return <b>{localStorage.getItem('draft')}</b>;
          }
        `,
      },
    ]);
    const findings = detectStorageAsState(graph, computeStackProfile(graph));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.recommendation).toContain("zustand");
  });
});
