import { describe, expect, it } from "vitest";
import { runStatelinter } from "./run.js";

describe("runStatelinter", () => {
  it("runs all detectors and sorts findings by file then line", () => {
    const findings = runStatelinter([
      {
        path: "b-drill.tsx",
        code: `
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
        `,
      },
      {
        path: "a-fetch.tsx",
        code: `
          function Users() {
            const [users, setUsers] = useState([]);
            useEffect(() => {
              fetch('/api/users').then((r) => r.json()).then(setUsers);
            }, []);
            return <ul>{users.length}</ul>;
          }
        `,
      },
    ]);

    expect(findings.map((f) => f.rule)).toEqual([
      "server-state-in-client-state",
      "prop-drilling",
    ]);
    expect(findings[0]!.loc.file).toBe("a-fetch.tsx");
    expect(findings[1]!.loc.file).toBe("b-drill.tsx");
  });

  it("returns an empty list for clean code", () => {
    const findings = runStatelinter([
      {
        path: "clean.tsx",
        code: `
          function Counter() {
            const [count, setCount] = useState(0);
            return <button onClick={() => setCount(count + 1)}>{count}</button>;
          }
        `,
      },
    ]);
    expect(findings).toEqual([]);
  });

  it("skips unparseable files via onParseError instead of throwing", () => {
    const skipped: string[] = [];
    const findings = runStatelinter(
      [
        { path: "broken.tsx", code: "function ??? not valid" },
        {
          path: "good.tsx",
          code: `
            function Ok() {
              const [x, setX] = useState(0);
              return <span>{x}</span>;
            }
          `,
        },
      ],
      { onParseError: (path) => skipped.push(path) },
    );
    expect(skipped).toEqual(["broken.tsx"]);
    expect(findings).toEqual([]);
  });

  it("throws on parse errors when no handler is given", () => {
    expect(() =>
      runStatelinter([{ path: "broken.tsx", code: "function ??? not valid" }]),
    ).toThrow();
  });
});

describe("runStatelinter — onMeta stack detection", () => {
  it("reports vue-only for a .vue SFC using pinia", () => {
    const metas: Array<{
      optionsComponents: number;
      stack: { react: boolean; vue: boolean; nuxt: boolean };
    }> = [];
    runStatelinter(
      [
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
          code: `<template>\n  <div>{{ items }}</div>\n</template>\n\n<script setup lang="ts">\nimport { useCartStore } from './stores/cart';\nconst store = useCartStore();\nconst items = store.items;\n</script>\n`,
        },
      ],
      { onMeta: (meta) => metas.push(meta) },
    );
    expect(metas).toHaveLength(1);
    expect(metas[0]!.stack).toEqual({ react: false, vue: true, nuxt: false });
  });

  it("reports react-only for a .tsx useState component", () => {
    const metas: Array<{
      optionsComponents: number;
      stack: { react: boolean; vue: boolean; nuxt: boolean };
    }> = [];
    runStatelinter(
      [
        {
          path: "Counter.tsx",
          code: `
            function Counter() {
              const [count, setCount] = useState(0);
              return <button onClick={() => setCount(count + 1)}>{count}</button>;
            }
          `,
        },
      ],
      { onMeta: (meta) => metas.push(meta) },
    );
    expect(metas).toHaveLength(1);
    expect(metas[0]!.stack).toEqual({ react: true, vue: false, nuxt: false });
  });

  it("reports both for a repo that mixes React and Vue components", () => {
    const metas: Array<{
      optionsComponents: number;
      stack: { react: boolean; vue: boolean; nuxt: boolean };
    }> = [];
    runStatelinter(
      [
        {
          path: "Counter.tsx",
          code: `
            function Counter() {
              const [count, setCount] = useState(0);
              return <button onClick={() => setCount(count + 1)}>{count}</button>;
            }
          `,
        },
        {
          path: "Cart.vue",
          code: `<template>\n  <div />\n</template>\n\n<script setup lang="ts">\nimport { ref } from 'vue';\nconst items = ref([]);\n</script>\n`,
        },
      ],
      { onMeta: (meta) => metas.push(meta) },
    );
    expect(metas).toHaveLength(1);
    expect(metas[0]!.stack).toEqual({ react: true, vue: true, nuxt: false });
  });
});
