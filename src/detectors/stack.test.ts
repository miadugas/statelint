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

  it("never points a Vue ref finding at RTK Query, even in an RTK-dominant graph", () => {
    const graph = buildStateGraph([
      // React side — RTK Query dominates the graph-wide profile.
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
      // Vue side — a hand-rolled ref + onMounted + fetch cache.
      {
        path: "src/UserPanel.vue",
        code: `<template>
  <div>{{ user?.name }}</div>
</template>
<script setup lang="ts">
import { ref, onMounted } from 'vue';
const user = ref(null);
onMounted(async () => {
  const res = await fetch('/api/user');
  user.value = await res.json();
});
</script>
`,
      },
    ]);
    const profile = computeStackProfile(graph);
    expect(profile.serverLib).toBe("RTK Query");
    const findings = detectServerStateInClientState(graph, profile);
    const vueFinding = findings.find((f) => f.loc.file === "src/UserPanel.vue");
    expect(vueFinding).toBeDefined();
    expect(vueFinding!.recommendation).toContain("@tanstack/vue-query");
    expect(vueFinding!.recommendation).not.toContain("RTK Query");
  });

  it("does not claim a Vue app 'already uses' TanStack when only vue-query kind is observed", () => {
    const graph = buildStateGraph([
      {
        path: "Todos.vue",
        code: `<template>
  <ul>{{ data?.length }}</ul>
</template>
<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
const { data } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos });
</script>
`,
      },
      {
        path: "Profile.vue",
        code: `<template>
  <div>{{ user?.name }}</div>
</template>
<script setup lang="ts">
import { ref, onMounted } from 'vue';
const user = ref(null);
onMounted(async () => {
  const res = await fetch('/api/user');
  user.value = await res.json();
});
</script>
`,
      },
    ]);
    const profile = computeStackProfile(graph);
    expect(profile.serverLib).toBe("TanStack Query");
    const findings = detectServerStateInClientState(graph, profile);
    const finding = findings.find(
      (f) => f.rule === "server-state-in-client-state",
    );
    expect(finding).toBeDefined();
    expect(finding!.recommendation).toContain("@tanstack/vue-query");
    expect(finding!.recommendation).not.toContain("already uses");
  });

  it("drops the pinia persist hint for an all-React localStorage finding (mixed repo)", () => {
    const graph = buildStateGraph([
      // Vue side — pinia dominates the store profile.
      {
        path: "stores/cart.ts",
        code: `
          import { defineStore } from 'pinia';
          export const useCartStore = defineStore('cart', {
            state: () => ({ items: [] }),
          });
        `,
      },
      {
        path: "Cart.vue",
        code: `<template>
  <span>{{ store.items.length }}</span>
</template>
<script setup lang="ts">
import { useCartStore } from './stores/cart';
const store = useCartStore();
</script>
`,
      },
      // React side — a localStorage key shared across two React components.
      {
        path: "src/A.tsx",
        code: `
          export function A() {
            return <span onClick={() => localStorage.setItem('draft', 'x')}>a</span>;
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
    const profile = computeStackProfile(graph);
    expect(profile.persistKind).toBe("pinia");
    const findings = detectStorageAsState(graph, profile);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.recommendation).not.toContain("pinia");
    expect(findings[0]!.recommendation).toContain(
      "one reactive store with a persist middleware",
    );
  });
});
