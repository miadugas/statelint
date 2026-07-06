import { describe, expect, it } from "vitest";
import { buildStateGraph } from "./build.js";
import {
  detectMultipleSourcesOfTruth,
  entityKey,
} from "../detectors/multiple-sources.js";

const CART_SLICE = `
  import { createSlice } from '@reduxjs/toolkit';
  export const cartSlice = createSlice({
    name: 'cart',
    initialState: { items: [], total: 0 },
    reducers: {
      addItem(state, action) { state.items.push(action.payload); },
    },
  });
`;

describe("redux adapter — createSlice", () => {
  it("registers slices by their name prop with initialState fields", () => {
    const graph = buildStateGraph([
      { path: "src/cartSlice.ts", code: CART_SLICE },
    ]);
    const source = graph.sources.get("redux:cart");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("redux-slice");
    expect(source?.classification).toBe("global-client");
    expect(source?.name).toBe("cart");
    expect(source?.shape?.fields).toEqual(["items", "total"]);
  });

  it("ignores createSlice from other libraries", () => {
    const graph = buildStateGraph([
      {
        path: "src/other.ts",
        code: `
          import { createSlice } from 'some-lib';
          export const s = createSlice({ name: 'cart' });
        `,
      },
    ]);
    expect(
      [...graph.sources.values()].some((s) => s.kind === "redux-slice"),
    ).toBe(false);
  });

  it("resolves useSelector state-path access to slice reads", () => {
    const graph = buildStateGraph([
      { path: "src/cartSlice.ts", code: CART_SLICE },
      {
        path: "src/Badge.tsx",
        code: `
          import { useSelector } from 'react-redux';
          export function Badge() {
            const count = useSelector((state) => state.cart.items.length);
            return <span>{count}</span>;
          }
        `,
      },
      {
        path: "src/Summary.tsx",
        code: `
          export function Summary() {
            const total = useAppSelector((state) => state.cart.total);
            return <b>{total}</b>;
          }
        `,
      },
    ]);

    const readers = graph.edges
      .filter((e) => e.type === "reads" && e.to === "redux:cart")
      .map((e) => e.from)
      .sort();
    expect(readers).toEqual(["src/Badge.tsx#Badge", "src/Summary.tsx#Summary"]);
  });

  it("resolves destructured selector params (({ cart }) => …)", () => {
    const graph = buildStateGraph([
      { path: "src/cartSlice.ts", code: CART_SLICE },
      {
        path: "src/Mini.tsx",
        code: `
          import { useSelector } from 'react-redux';
          export function Mini() {
            const items = useSelector(({ cart }) => cart.items);
            return <ul>{items.length}</ul>;
          }
        `,
      },
    ]);
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/Mini.tsx#Mini",
      to: "redux:cart",
      via: "selector",
    });
  });
});

describe("redux adapter — RTK Query", () => {
  const USER_API = `
    import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
    export const userApi = createApi({
      reducerPath: 'userApi',
      baseQuery: fetchBaseQuery({ baseUrl: '/api' }),
      endpoints: (builder) => ({
        getUser: builder.query({ query: () => '/me' }),
        updateUser: builder.mutation({ query: (body) => ({ url: '/me', body }) }),
      }),
    });
  `;

  it("registers query endpoints (not mutations) as server-cache sources", () => {
    const graph = buildStateGraph([{ path: "src/userApi.ts", code: USER_API }]);
    const source = graph.sources.get("rtkq:getUser");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("rtk-query");
    expect(source?.classification).toBe("server-cache");
    expect(graph.sources.has("rtkq:updateUser")).toBe(false);
  });

  it("attributes generated hooks (useGetUserQuery) to reads", () => {
    const graph = buildStateGraph([
      { path: "src/userApi.ts", code: USER_API },
      {
        path: "src/Profile.tsx",
        code: `
          import { useGetUserQuery } from './userApi';
          export function Profile() {
            const { data } = useGetUserQuery();
            return <span>{data?.name}</span>;
          }
        `,
      },
    ]);
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/Profile.tsx#Profile",
      to: "rtkq:getUser",
      via: "hook",
    });
  });
});

describe("cross-library detection with redux", () => {
  it("entityKey strips RTK endpoint verbs", () => {
    expect(entityKey("getUser")).toBe("user");
    expect(entityKey("fetchOrders")).toBe("orders");
  });

  it("flags a redux slice competing with a zustand store", () => {
    const graph = buildStateGraph([
      { path: "src/cartSlice.ts", code: CART_SLICE },
      {
        path: "src/cartStore.ts",
        code: `
          import { create } from 'zustand';
          export const useCartStore = create(() => ({ items: [] }));
        `,
      },
    ]);
    const findings = detectMultipleSourcesOfTruth(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("'cart'");
    expect(findings[0]!.message).toContain("redux-slice store 'cart'");
    expect(findings[0]!.message).toContain("useCartStore");
  });

  it("flags an RTK endpoint competing with a hand-rolled fetch cache", () => {
    const graph = buildStateGraph([
      {
        path: "src/userApi.ts",
        code: `
          import { createApi } from '@reduxjs/toolkit/query/react';
          export const userApi = createApi({
            endpoints: (builder) => ({
              getUser: builder.query({ query: () => '/me' }),
            }),
          });
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
    expect(findings[0]!.message).toContain("Server entity 'user'");
    expect(findings[0]!.message).toContain("query 'getUser'");
  });
});
