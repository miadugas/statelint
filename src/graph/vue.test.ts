import { describe, expect, it } from "vitest";
import { buildStateGraph } from "./build.js";
import { computeStackProfile } from "../detectors/stack.js";
import { runStatelinter } from "../run.js";

/** Pinia store in a plain .ts module — the normal layout. */
const CART_STORE = `
import { defineStore } from 'pinia';

export const useCartStore = defineStore('cart', {
  state: () => ({ items: [], coupon: null }),
});
`;

/** Setup-syntax store. */
const USER_STORE = `
import { ref } from 'vue';
import { defineStore } from 'pinia';

export const useUserStore = defineStore('user', () => {
  const name = ref('Ada');
  const setName = (n) => { name.value = n; };
  return { name, setName };
});
`;

const SFC = (script: string, template = "<div />"): string =>
  `<template>\n  ${template}\n</template>\n\n<script setup lang="ts">${script}</script>\n`;

/** Options API SFC — plain `<script>`, no `setup` attribute. Modeled unless
 * it uses an escape hatch (unresolvable mixins, extends, or an unrecognized
 * script shape). */
const OPTIONS_SFC = (script: string, template = "<div />"): string =>
  `<template>\n  ${template}\n</template>\n\n<script lang="ts">${script}</script>\n`;

/** Options SFC statelinter can't model — the mixin import doesn't resolve to
 * an analyzed file, so its state would flow in invisibly and the component
 * stays in unresolved.optionsComponents. */
const MIXIN_SFC = OPTIONS_SFC(`
import baseMixin from './base-mixin';
export default {
  mixins: [baseMixin],
  data() {
    return { x: 1 };
  },
};
`);

describe("Vue SFC — components and sources", () => {
  it("registers the SFC as a component named after the file", () => {
    const graph = buildStateGraph([
      {
        path: "src/components/TheHeader.vue",
        code: SFC(`\nimport { ref } from 'vue';\nconst open = ref(false);\n`),
      },
    ]);
    const names = [...graph.components.values()].map((c) => c.name);
    expect(names).toEqual(["TheHeader"]);
  });

  it("classifies ref as local, reactive as local, computed as derived", () => {
    const graph = buildStateGraph([
      {
        path: "App.vue",
        code: SFC(`
import { ref, reactive, computed } from 'vue';
const count = ref(0);
const form = reactive({ email: '', password: '' });
const doubled = computed(() => count.value * 2);
`),
      },
    ]);
    const byName = new Map([...graph.sources.values()].map((s) => [s.name, s]));
    expect(byName.get("count")?.kind).toBe("ref");
    expect(byName.get("count")?.classification).toBe("local");
    expect(byName.get("form")?.kind).toBe("reactive");
    expect(byName.get("form")?.shape?.fields).toEqual(["email", "password"]);
    expect(byName.get("doubled")?.kind).toBe("computed");
    expect(byName.get("doubled")?.classification).toBe("derived");
  });

  it("does not claim ref/computed for names not imported from vue", () => {
    const graph = buildStateGraph([
      {
        path: "App.vue",
        code: SFC(`
import { ref } from './my-lib';
const x = ref(0);
`),
      },
    ]);
    expect(graph.sources.size).toBe(0);
  });

  it("emits reads and writes edges for refs", () => {
    const graph = buildStateGraph([
      {
        path: "Counter.vue",
        code: SFC(`
import { ref } from 'vue';
const count = ref(0);
const increment = () => { count.value = count.value + 1; };
const label = () => 'clicks: ' + count.value;
`),
      },
    ]);
    const id = [...graph.sources.keys()][0]!;
    const reads = graph.edges.filter((e) => e.type === "reads" && e.to === id);
    const writes = graph.edges.filter(
      (e) => e.type === "writes" && e.to === id,
    );
    expect(reads).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ via: "setter" });
  });

  it("skips template-only SFCs without crashing", () => {
    const graph = buildStateGraph([
      {
        path: "Logo.vue",
        code: "<template>\n  <img src='/logo.svg'>\n</template>\n",
      },
    ]);
    expect(graph.components.size).toBe(0);
  });
});

describe("Vue — pinia adapter", () => {
  it("registers options and setup stores with fields, identity by store id", () => {
    const graph = buildStateGraph([
      { path: "stores/cart.ts", code: CART_STORE },
      { path: "stores/user.ts", code: USER_STORE },
    ]);
    const cart = graph.sources.get("pinia:cart");
    const user = graph.sources.get("pinia:user");
    expect(cart?.kind).toBe("pinia");
    expect(cart?.classification).toBe("global-client");
    expect(cart?.shape?.fields).toEqual(["items", "coupon"]);
    expect(user?.shape?.fields).toEqual(["name", "setName"]);
  });

  it("emits reads for use*Store() calls, selector reads for storeToRefs, writes for $patch and mutation", () => {
    const graph = buildStateGraph([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "Cart.vue",
        code: SFC(`
import { storeToRefs } from 'pinia';
import { useCartStore } from './stores/cart';
const store = useCartStore();
const { items } = storeToRefs(store);
const clear = () => store.$patch({ items: [] });
const applyCoupon = (c) => { store.coupon = c; };
`),
      },
    ]);
    const edges = graph.edges.filter((e) => e.to === "pinia:cart");
    const kinds = edges.map((e) => `${e.type}:${"via" in e ? e.via : ""}`);
    expect(kinds).toContain("reads:hook");
    expect(kinds).toContain("reads:selector");
    expect(kinds).toContain("writes:setState");
    expect(kinds).toContain("writes:mutate");
  });

  it("counts reads through composables (the fixpoint) and keeps reader counts honest", () => {
    const findings = runStatelinter([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "composables/useCart.ts",
        code: `
import { useCartStore } from '../stores/cart';
export function useCartTotal() {
  const store = useCartStore();
  return store.items.length;
}
`,
      },
      {
        path: "Cart.vue",
        code: SFC(`
import { useCartTotal } from './composables/useCart';
const total = useCartTotal();
`),
      },
      {
        path: "Badge.vue",
        code: SFC(`
import { useCartStore } from './stores/cart';
const store = useCartStore();
`),
      },
    ]);
    // Two distinct reader components — over-globalized must stay silent.
    expect(
      findings.filter((f) => f.rule === "over-globalized-state"),
    ).toHaveLength(0);
  });

  it("flags a single-reader pinia store with Vue wording", () => {
    const findings = runStatelinter([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "Cart.vue",
        code: SFC(`
import { useCartStore } from './stores/cart';
const store = useCartStore();
`),
      },
    ]);
    const finding = findings.find((f) => f.rule === "over-globalized-state");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("exactly one component (Cart)");
    expect(finding?.recommendation).toContain("ref()s inside Cart");
  });

  it("a component reading via both hook and storeToRefs is still ONE reader", () => {
    const findings = runStatelinter([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "Cart.vue",
        code: SFC(`
import { storeToRefs } from 'pinia';
import { useCartStore } from './stores/cart';
const store = useCartStore();
const { items } = storeToRefs(store);
`),
      },
    ]);
    expect(
      findings.filter((f) => f.rule === "over-globalized-state"),
    ).toHaveLength(1);
  });
});

describe("Vue — provide/inject", () => {
  it("emits provides/consumes edges and flags a single-consumer key", () => {
    const findings = runStatelinter([
      {
        path: "App.vue",
        code: SFC(`
import { ref, provide } from 'vue';
const theme = ref('dark');
provide('theme', theme);
`),
      },
      {
        path: "Footer.vue",
        code: SFC(`
import { inject } from 'vue';
const theme = inject('theme');
`),
      },
    ]);
    const finding = findings.find((f) => f.rule === "over-globalized-state");
    expect(finding?.message).toContain("Provided key 'theme'");
    expect(finding?.message).toContain("exactly one component (Footer)");
    expect(finding?.recommendation).toContain("provide/inject");
  });

  it("stays silent with two consumers", () => {
    const inject = SFC(
      `\nimport { inject } from 'vue';\nconst theme = inject('theme');\n`,
    );
    const findings = runStatelinter([
      {
        path: "App.vue",
        code: SFC(
          `\nimport { ref, provide } from 'vue';\nprovide('theme', ref('dark'));\n`,
        ),
      },
      { path: "Footer.vue", code: inject },
      { path: "Header.vue", code: inject },
    ]);
    expect(
      findings.filter((f) => f.rule === "over-globalized-state"),
    ).toHaveLength(0);
  });
});

describe("Vue — server-fed and derived refs", () => {
  it("registers useQuery from @tanstack/vue-query inside an SFC as a server-cache source", () => {
    const graph = buildStateGraph([
      {
        path: "Todos.vue",
        code: SFC(
          `
import { useQuery } from '@tanstack/vue-query';
const { data } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos });
`,
          "<ul>{{ data?.length }}</ul>",
        ),
      },
    ]);

    const source = graph.sources.get("query:todos");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("tanstack-query");
    expect(source?.classification).toBe("server-cache");
    expect(source?.name).toBe("todos");
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "Todos.vue#Todos",
      to: "query:todos",
      via: "hook",
    });
  });

  it("classifies a ref fed by onMounted+fetch as server-cache and recommends vue-query", () => {
    const findings = runStatelinter([
      {
        path: "Profile.vue",
        code: SFC(`
import { ref, onMounted } from 'vue';
const user = ref(null);
onMounted(async () => {
  const res = await fetch('/api/user');
  user.value = await res.json();
});
`),
      },
    ]);
    const finding = findings.find(
      (f) => f.rule === "server-state-in-client-state",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("lives in ref");
    expect(finding?.recommendation).toContain("@tanstack/vue-query");
    expect(finding?.recommendation).toContain("ref + onMounted + fetch");
  });

  it("flags a ref recomputed by a sync watcher as derived, recommending computed", () => {
    const findings = runStatelinter([
      {
        path: "Search.vue",
        code: SFC(`
import { ref, watch } from 'vue';
const query = ref('');
const normalized = ref('');
watch(query, () => {
  normalized.value = query.value.trim().toLowerCase();
});
`),
      },
    ]);
    const finding = findings.find((f) => f.rule === "derived-state-as-state");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("synchronous watcher");
    expect(finding?.recommendation).toContain("computed(() =>");
  });

  it("never calls a ref derived when the template might mutate it (v-model)", () => {
    const findings = runStatelinter([
      {
        path: "Search.vue",
        code: SFC(
          `
import { ref, watch } from 'vue';
const query = ref('');
const normalized = ref('');
watch(query, () => {
  normalized.value = query.value.trim();
});
`,
          `<input v-model="normalized" />`,
        ),
      },
    ]);
    expect(
      findings.filter((f) => f.rule === "derived-state-as-state"),
    ).toHaveLength(0);
  });

  it("a ref also written outside the watcher is not derived", () => {
    const findings = runStatelinter([
      {
        path: "Search.vue",
        code: SFC(`
import { ref, watch } from 'vue';
const query = ref('');
const normalized = ref('');
watch(query, () => {
  normalized.value = query.value.trim();
});
const reset = () => { normalized.value = ''; };
`),
      },
    ]);
    expect(
      findings.filter((f) => f.rule === "derived-state-as-state"),
    ).toHaveLength(0);
  });
});

describe("Vue — server-fed and derived reactive objects", () => {
  it("emits a writes edge for a reactive property assignment", () => {
    const graph = buildStateGraph([
      {
        path: "Form.vue",
        code: SFC(`
import { reactive } from 'vue';
const form = reactive({ email: '', name: '' });
const update = () => { form.email = 'x'; };
`),
      },
    ]);
    const form = [...graph.sources.values()].find((s) => s.name === "form");
    expect(form?.kind).toBe("reactive");
    expect(graph.edges).toContainEqual({
      type: "writes",
      from: "Form.vue#Form",
      to: form!.id,
      via: "mutate",
    });
  });

  it("classifies a reactive object fed by onMounted+fetch as server-cache and recommends vue-query", () => {
    const findings = runStatelinter([
      {
        path: "Profile.vue",
        code: SFC(`
import { reactive, onMounted } from 'vue';
const state = reactive({ user: null });
onMounted(async () => {
  const res = await fetch('/api/user');
  state.user = await res.json();
});
`),
      },
    ]);
    const finding = findings.find(
      (f) => f.rule === "server-state-in-client-state",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("lives in reactive(...)");
    expect(finding?.recommendation).toContain("@tanstack/vue-query");
    expect(finding?.recommendation).toContain("reactive + onMounted + fetch");
  });

  it("flags a reactive property recomputed by a sync watcher as derived, recommending computed", () => {
    const findings = runStatelinter([
      {
        path: "Search.vue",
        code: SFC(`
import { reactive, watch } from 'vue';
const state = reactive({ query: '', normalized: '' });
watch(() => state.query, () => {
  state.normalized = state.query.trim().toLowerCase();
});
`),
      },
    ]);
    const finding = findings.find((f) => f.rule === "derived-state-as-state");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("synchronous watcher");
    expect(finding?.recommendation).toContain("computed(() =>");
    expect(finding?.recommendation).toContain("reactive(...)");
  });

  it("never calls a reactive object derived when the template might mutate it (v-model)", () => {
    const findings = runStatelinter([
      {
        path: "Search.vue",
        code: SFC(
          `
import { reactive, watch } from 'vue';
const state = reactive({ query: '', normalized: '' });
watch(() => state.query, () => {
  state.normalized = state.query.trim();
});
`,
          `<input v-model="state.query" />`,
        ),
      },
    ]);
    expect(
      findings.filter((f) => f.rule === "derived-state-as-state"),
    ).toHaveLength(0);
  });

  it("a reactive property also written outside the watcher is not derived", () => {
    const findings = runStatelinter([
      {
        path: "Search.vue",
        code: SFC(`
import { reactive, watch } from 'vue';
const state = reactive({ query: '', normalized: '' });
watch(() => state.query, () => {
  state.normalized = state.query.trim();
});
const reset = () => { state.normalized = ''; };
`),
      },
    ]);
    expect(
      findings.filter((f) => f.rule === "derived-state-as-state"),
    ).toHaveLength(0);
  });

  // Honesty constraint: object-level attribution must never confidently tell a
  // user to move a whole reactive object that's partly form state. One property
  // fed by fetch + another mutated by a handler softens to the draft severity
  // (info), exactly as an edited-outside ref does — never a confident warn.
  it("softens (never confidently warns) a mixed-use reactive: fetched + handler-edited", () => {
    const findings = runStatelinter([
      {
        path: "Profile.vue",
        code: SFC(`
import { reactive, onMounted } from 'vue';
const state = reactive({ user: null, draftName: '' });
onMounted(async () => {
  const res = await fetch('/api/user');
  state.user = await res.json();
});
const rename = (n) => { state.draftName = n; };
`),
      },
    ]);
    const server = findings.filter(
      (f) => f.rule === "server-state-in-client-state",
    );
    // Softened to the prefilled-draft severity, not a confident "move it" warn.
    expect(server.every((f) => f.severity !== "warn")).toBe(true);
    if (server.length > 0) expect(server[0]!.severity).toBe("info");
    // And never a derived finding.
    expect(
      findings.filter((f) => f.rule === "derived-state-as-state"),
    ).toHaveLength(0);
  });
});

describe("Vue — template analysis (Tier 2)", () => {
  const ORIGIN = `<template>
  <AppLayout :user="user" />
</template>
<script setup lang="ts">
import { ref } from 'vue';
import AppLayout from './AppLayout.vue';
const user = ref({ name: 'Ada' });
</script>
`;
  const LAYOUT = `<template>
  <div class="layout"><SideBar :user="user" /></div>
</template>
<script setup lang="ts">
import SideBar from './SideBar.vue';
defineProps<{ user: { name: string } }>();
</script>
`;
  const SIDEBAR = `<template>
  <ProfileCard :user="user" />
</template>
<script setup lang="ts">
import ProfileCard from './ProfileCard.vue';
defineProps<{ user: { name: string } }>();
</script>
`;
  const LEAF = `<template>
  <span>{{ user.name }}</span>
</template>
<script setup lang="ts">
defineProps<{ user: { name: string } }>();
</script>
`;

  const drillFiles = () => [
    { path: "App.vue", code: ORIGIN },
    { path: "AppLayout.vue", code: LAYOUT },
    { path: "SideBar.vue", code: SIDEBAR },
    { path: "ProfileCard.vue", code: LEAF },
  ];

  it("builds passesProp edges from template binds with forward/read distinction", () => {
    const graph = buildStateGraph(drillFiles());
    const passes = graph.edges.filter((e) => e.type === "passesProp");
    expect(passes).toHaveLength(3);
    const reads = passes.map((e) => ("reads" in e ? e.reads : null));
    expect(reads).toEqual([false, false, true]); // two blind forwards, leaf reads
  });

  it("fires prop-drilling on a Vue chain with slot wording (local origin)", () => {
    const findings = runStatelinter(drillFiles());
    const finding = findings.find((f) => f.rule === "prop-drilling");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("AppLayout → SideBar");
    expect(finding?.recommendation).toContain("slot");
  });

  it("recommends reading shared state at the leaf when the origin holds pinia state", () => {
    const piniaOrigin = `<template>
  <AppLayout :user="store.profile" />
</template>
<script setup lang="ts">
import AppLayout from './AppLayout.vue';
import { useUserStore } from './stores/user';
const store = useUserStore();
</script>
`;
    const findings = runStatelinter([
      { path: "stores/user.ts", code: USER_STORE },
      { path: "App.vue", code: piniaOrigin },
      { path: "AppLayout.vue", code: LAYOUT },
      { path: "SideBar.vue", code: SIDEBAR },
      { path: "ProfileCard.vue", code: LEAF },
    ]);
    const finding = findings.find((f) => f.rule === "prop-drilling");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("info"); // shared state drilled = cleanup, not defect
    expect(finding?.recommendation).toContain(
      "read it directly in ProfileCard",
    );
  });

  it("resolves kebab-case tags and props through Nuxt auto-registration", () => {
    const graph = buildStateGraph([
      {
        path: "pages/index.vue",
        code: `<template>
  <user-card :user-name="userName" />
</template>
<script setup lang="ts">
const userName = ref('Ada');
</script>
`,
      },
      {
        path: "components/UserCard.vue",
        code: `<template><b>{{ userName }}</b></template>
<script setup lang="ts">
defineProps<{ userName: string }>();
</script>
`,
      },
    ]);
    const pass = graph.edges.find((e) => e.type === "passesProp");
    expect(pass).toMatchObject({ prop: "userName", reads: true });
  });

  it("a middle component that also reads the prop breaks the blind chain", () => {
    const readingLayout = LAYOUT.replace(
      '<div class="layout">',
      '<div :title="user.name">',
    );
    const findings = runStatelinter([
      { path: "App.vue", code: ORIGIN },
      { path: "AppLayout.vue", code: readingLayout },
      { path: "SideBar.vue", code: SIDEBAR },
      { path: "ProfileCard.vue", code: LEAF },
    ]);
    expect(findings.filter((f) => f.rule === "prop-drilling")).toHaveLength(0);
  });

  it("emits template-only reads as reads edges", () => {
    const graph = buildStateGraph([
      {
        path: "Badge.vue",
        code: `<template><span>{{ count }}</span></template>
<script setup lang="ts">
import { ref } from 'vue';
const count = ref(0);
</script>
`,
      },
    ]);
    const id = [...graph.sources.keys()][0]!;
    expect(graph.edges.some((e) => e.type === "reads" && e.to === id)).toBe(
      true,
    );
  });

  it("handler mutations (@click) disqualify derived, plain interpolation does not", () => {
    const watcher = (template: string) => `<template>
  ${template}
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
const query = ref('');
const normalized = ref('');
watch(query, () => { normalized.value = query.value.trim(); });
</script>
`;
    const mutated = runStatelinter([
      {
        path: "A.vue",
        code: watcher(
          `<button @click="normalized = ''">{{ normalized }}</button>`,
        ),
      },
    ]);
    expect(
      mutated.filter((f) => f.rule === "derived-state-as-state"),
    ).toHaveLength(0);

    const readOnly = runStatelinter([
      { path: "B.vue", code: watcher(`<span>{{ normalized }}</span>`) },
    ]);
    expect(
      readOnly.filter((f) => f.rule === "derived-state-as-state"),
    ).toHaveLength(1);
  });

  it("never claims a chain through an ambiguous auto-registered component name", () => {
    const dup = `<template><i>{{ user }}</i></template>
<script setup lang="ts">
defineProps<{ user: string }>();
</script>
`;
    const graph = buildStateGraph([
      {
        path: "App.vue",
        code: `<template><UserCard :user="user" /></template>
<script setup lang="ts">
import { ref } from 'vue';
const user = ref('');
</script>
`,
      },
      { path: "a/UserCard.vue", code: dup },
      { path: "b/UserCard.vue", code: dup },
    ]);
    expect(graph.edges.filter((e) => e.type === "passesProp")).toHaveLength(0);
  });
});

describe("Vue — cross-cutting detectors", () => {
  it("multiple-sources fires on a pinia store + localStorage key holding the same entity", () => {
    const findings = runStatelinter([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "Cart.vue",
        code: SFC(`
import { useCartStore } from './stores/cart';
const store = useCartStore();
const persist = () => localStorage.setItem('cart', JSON.stringify(store.items));
`),
      },
      {
        path: "Badge.vue",
        code: SFC(`
import { useCartStore } from './stores/cart';
const store = useCartStore();
`),
      },
    ]);
    const finding = findings.find(
      (f) => f.rule === "multiple-sources-of-truth",
    );
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("pinia store 'cart'");
    expect(finding?.message).toContain("localStorage key 'cart'");
  });

  it("storage access inside a .vue script is tracked like any other", () => {
    const graph = buildStateGraph([
      {
        path: "Settings.vue",
        code: SFC(`
const saved = localStorage.getItem('locale');
`),
      },
    ]);
    expect(graph.sources.get("storage:local:locale")).toBeDefined();
  });
});

describe("Vue — Options API (unmodeled)", () => {
  it("counts an unresolvable-mixin <script> SFC as an unresolved Options API component", () => {
    const graph = buildStateGraph([{ path: "Legacy.vue", code: MIXIN_SFC }]);
    expect(graph.unresolved.optionsComponents).toBe(1);
  });

  it("suppresses the single-reader pinia finding when an unmodeled Options API component exists", () => {
    const findings = runStatelinter([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "Cart.vue",
        code: SFC(`
import { useCartStore } from './stores/cart';
const store = useCartStore();
`),
      },
      { path: "Legacy.vue", code: MIXIN_SFC },
    ]);
    expect(
      findings.filter((f) => f.rule === "over-globalized-state"),
    ).toHaveLength(0);
  });

  it("suppresses the single-consumer provide/inject finding when an unmodeled Options API component exists", () => {
    const provider = {
      path: "App.vue",
      code: SFC(`
import { ref, provide } from 'vue';
provide('theme', ref('dark'));
`),
    };
    const consumer = {
      path: "Footer.vue",
      code: SFC(`
import { inject } from 'vue';
const theme = inject('theme');
`),
    };
    const legacy = { path: "Legacy.vue", code: MIXIN_SFC };
    // An inject() inside the unmodeled Options component would be invisible —
    // "exactly one consumer" is a floor, not a total. Stay silent.
    const suppressed = runStatelinter([provider, consumer, legacy]);
    expect(
      suppressed.filter((f) => f.rule === "over-globalized-state"),
    ).toHaveLength(0);

    // Without the Options component the count is exhaustive — finding fires.
    const findings = runStatelinter([provider, consumer]);
    const finding = findings.find((f) => f.rule === "over-globalized-state");
    expect(finding?.message).toContain("Provided key 'theme'");
    expect(finding?.message).toContain("exactly one component (Footer)");
  });

  it("parses a .js file with JSX and registers the component", () => {
    const graph = buildStateGraph([
      {
        path: "App.js",
        code: `
import { useState } from 'react';
export default function App() {
  const [count, setCount] = useState(0);
  return <div>{count}</div>;
}
`,
      },
    ]);
    const names = [...graph.components.values()].map((c) => c.name);
    expect(names).toContain("App");
  });
});

describe("Vue — Options API (modeled)", () => {
  it("registers data as options-data/local, computed as derived, with this.x read/write edges", () => {
    const graph = buildStateGraph([
      {
        path: "Counter.vue",
        code: OPTIONS_SFC(`
export default {
  data() {
    return { count: 0 };
  },
  computed: {
    doubled() { return this.count * 2; },
  },
  methods: {
    increment() { this.count = this.count + 1; },
  },
};
`),
      },
    ]);
    const byName = new Map([...graph.sources.values()].map((s) => [s.name, s]));
    expect(byName.get("count")?.kind).toBe("options-data");
    expect(byName.get("count")?.classification).toBe("local");
    expect(byName.get("doubled")?.kind).toBe("computed");
    expect(byName.get("doubled")?.classification).toBe("derived");
    const countId = byName.get("count")!.id;
    expect(
      graph.edges.some((e) => e.type === "reads" && e.to === countId),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) => e.type === "writes" && e.to === countId && e.via === "mutate",
      ),
    ).toBe(true);
    expect(graph.unresolved.optionsComponents).toBe(0);
  });

  it("registers props so a declared-but-unread prop counts as a blind forward", () => {
    // If props: ['user'] weren't registered, the undeclared-prop fallback
    // would claim reads: true — reads: false proves registration.
    const graph = buildStateGraph([
      {
        path: "App.vue",
        code: SFC(
          `\nimport { ref } from 'vue';\nimport Card from './Card.vue';\nconst user = ref({});\n`,
          `<Card :user="user" />`,
        ),
      },
      {
        path: "Card.vue",
        code: OPTIONS_SFC(`
export default {
  props: ['user'],
};
`),
      },
    ]);
    const pass = graph.edges.find((e) => e.type === "passesProp");
    expect(pass).toMatchObject({ prop: "user", reads: false });
  });

  it("classifies data fed by mounted + axios .then as server-cache with data() wording", () => {
    const findings = runStatelinter([
      {
        path: "Items.vue",
        code: OPTIONS_SFC(`
import axios from 'axios';
export default {
  data() {
    return { items: [] };
  },
  mounted() {
    axios.get('/api/items').then(r => { this.items = r.data; });
  },
};
`),
      },
    ]);
    const finding = findings.find(
      (f) => f.rule === "server-state-in-client-state",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("lives in data()");
    expect(finding?.recommendation).toContain(
      "data() + lifecycle-hook + fetch",
    );
  });

  it("softens to info when a method also assigns the fetched field (prefilled draft)", () => {
    const findings = runStatelinter([
      {
        path: "Items.vue",
        code: OPTIONS_SFC(`
import axios from 'axios';
export default {
  data() {
    return { items: [] };
  },
  mounted() {
    axios.get('/api/items').then(r => { this.items = r.data; });
  },
  methods: {
    reset() { this.items = []; },
  },
};
`),
      },
    ]);
    const finding = findings.find(
      (f) => f.rule === "server-state-in-client-state",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("info");
    expect(finding?.message).toContain("prefilled form draft");
  });

  it("does not call an addEventListener-assigned field server-fed despite an unrelated await", () => {
    const graph = buildStateGraph([
      {
        path: "Resize.vue",
        code: OPTIONS_SFC(`
export default {
  data() {
    return { width: 0 };
  },
  async mounted() {
    await fetch('/api/warmup');
    window.addEventListener('resize', () => { this.width = window.innerWidth; });
  },
};
`),
      },
    ]);
    const width = [...graph.sources.values()].find((s) => s.name === "width");
    expect(width?.classification).toBe("local");
    expect(width?.serverFed).toBeUndefined();
  });

  it("flags a sync watch handler assigning a data field as derived, recommending computed", () => {
    const findings = runStatelinter([
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
export default {
  data() {
    return { items: [], total: 0 };
  },
  watch: {
    items() {
      this.total = this.items.length;
    },
  },
};
`),
      },
    ]);
    const finding = findings.find((f) => f.rule === "derived-state-as-state");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("'total'");
    expect(finding?.recommendation).toContain("computed");
  });

  it("a method mutating the watched-into field kills the derived finding", () => {
    const findings = runStatelinter([
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
export default {
  data() {
    return { items: [], total: 0 };
  },
  watch: {
    items() {
      this.total = this.items.length;
    },
  },
  methods: {
    clear() { this.total = 0; },
  },
};
`),
      },
    ]);
    expect(
      findings.filter((f) => f.rule === "derived-state-as-state"),
    ).toHaveLength(0);
  });

  it("detects a drill chain end-to-end through an Options API middle component", () => {
    const origin = `<template>
  <AppLayout :user="user" />
</template>
<script setup lang="ts">
import { ref } from 'vue';
import AppLayout from './AppLayout.vue';
const user = ref({ name: 'Ada' });
</script>
`;
    const layout = `<template>
  <div class="layout"><SideBar :user="user" /></div>
</template>
<script setup lang="ts">
import SideBar from './SideBar.vue';
defineProps<{ user: { name: string } }>();
</script>
`;
    const optionsMiddle = `<template>
  <ProfileCard :user="user" />
</template>
<script lang="ts">
import ProfileCard from './ProfileCard.vue';
export default {
  components: { ProfileCard },
  props: ['user'],
};
</script>
`;
    const leaf = `<template>
  <span>{{ user.name }}</span>
</template>
<script setup lang="ts">
defineProps<{ user: { name: string } }>();
</script>
`;
    const findings = runStatelinter([
      { path: "App.vue", code: origin },
      { path: "AppLayout.vue", code: layout },
      { path: "SideBar.vue", code: optionsMiddle },
      { path: "ProfileCard.vue", code: leaf },
    ]);
    const finding = findings.find((f) => f.rule === "prop-drilling");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("AppLayout → SideBar");
  });

  it("emits a reads edge for a template read of a data field", () => {
    const graph = buildStateGraph([
      {
        path: "Badge.vue",
        code: OPTIONS_SFC(
          `
export default {
  data() {
    return { count: 0 };
  },
};
`,
          `<span>{{ count }}</span>`,
        ),
      },
    ]);
    const id = [...graph.sources.keys()][0]!;
    expect(graph.edges.some((e) => e.type === "reads" && e.to === id)).toBe(
      true,
    );
  });

  it("v-model on a data field is a template mutation that kills derived", () => {
    const findings = runStatelinter([
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(
          `
export default {
  data() {
    return { items: [], total: 0 };
  },
  watch: {
    items() {
      this.total = this.items.length;
    },
  },
};
`,
          `<input v-model="total" />`,
        ),
      },
    ]);
    expect(
      findings.filter((f) => f.rule === "derived-state-as-state"),
    ).toHaveLength(0);
  });

  it("a clean modeled options SFC leaves the unresolved counter at zero; an unresolvable mixin bumps it", () => {
    const clean = buildStateGraph([
      {
        path: "Clean.vue",
        code: OPTIONS_SFC(`
export default {
  data() {
    return { open: false };
  },
};
`),
      },
    ]);
    expect(clean.unresolved.optionsComponents).toBe(0);

    const mixed = buildStateGraph([{ path: "Legacy.vue", code: MIXIN_SFC }]);
    expect(mixed.unresolved.optionsComponents).toBe(1);
  });
});

describe("Vue — Nuxt auto-imports", () => {
  it("registers auto-imported ref/computed sources without import statements", () => {
    const graph = buildStateGraph([
      {
        path: "pages/index.vue",
        code: SFC(`
const count = ref(0);
const doubled = computed(() => count.value * 2);
`),
      },
    ]);
    const kinds = [...graph.sources.values()].map((s) => s.kind).sort();
    expect(kinds).toEqual(["computed", "ref"]);
  });

  it("does not claim a locally-shadowed ref", () => {
    const graph = buildStateGraph([
      {
        path: "pages/index.vue",
        code: SFC(`
function ref(v) { return { value: v }; }
const count = ref(0);
`),
      },
    ]);
    expect(graph.sources.size).toBe(0);
  });

  it("detects Nuxt and recommends useAsyncData for a hand-rolled fetch", () => {
    const findings = runStatelinter([
      {
        path: "pages/blog.vue",
        code: SFC(`
definePageMeta({ layout: 'default' });
const post = ref(null);
onMounted(async () => {
  const res = await fetch('/api/post');
  post.value = await res.json();
});
`),
      },
    ]);
    const finding = findings.find(
      (f) => f.rule === "server-state-in-client-state",
    );
    expect(finding).toBeDefined();
    expect(finding?.recommendation).toContain("useAsyncData/useFetch");
  });

  it("resolves auto-imported pinia stores by unique name across the file set", () => {
    const findings = runStatelinter([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "pages/cart.vue",
        code: SFC(`
const store = useCartStore();
`),
      },
    ]);
    const finding = findings.find((f) => f.rule === "over-globalized-state");
    expect(finding?.message).toContain("'cart'");
  });

  it("refuses ambiguous auto-imported store names instead of guessing", () => {
    const dupStore = (id: string) => `
import { defineStore } from 'pinia';
export const useCartStore = defineStore('${id}', { state: () => ({ items: [] }) });
`;
    const graph = buildStateGraph([
      { path: "stores/a.ts", code: dupStore("cartA") },
      { path: "stores/b.ts", code: dupStore("cartB") },
      {
        path: "Cart.vue",
        code: SFC(`
const store = useCartStore();
`),
      },
    ]);
    const reads = graph.edges.filter(
      (e) => e.type === "reads" && String(e.to).startsWith("pinia:"),
    );
    expect(reads).toHaveLength(0);
  });

  it("storage access inside a .vue script is tracked like any other", () => {
    const graph = buildStateGraph([
      {
        path: "Settings.vue",
        code: SFC(`
const saved = localStorage.getItem('locale');
`),
      },
    ]);
    expect(graph.sources.get("storage:local:locale")).toBeDefined();
  });
});

describe("Vue — Options API setup() option", () => {
  it("models setup() with pinia + computed + lifecycle: store read, derived source, returned-name template read, resolved", () => {
    const graph = buildStateGraph([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(
          `
import { computed, onMounted } from 'vue';
import { useCartStore } from './stores/cart';
export default {
  setup() {
    const store = useCartStore();
    const items = computed(() => store.items);
    onMounted(() => { store.load(); });
    return { items };
  },
};
`,
          `<ul>{{ items }}</ul>`,
        ),
      },
    ]);
    expect(graph.unresolved.optionsComponents).toBe(0);
    // useCartStore() inside setup() reads the store, like script setup.
    expect(
      graph.edges.some(
        (e) => e.type === "reads" && e.to === "pinia:cart" && e.via === "hook",
      ),
    ).toBe(true);
    // computed() inside setup() is a derived source.
    const items = graph.sources.get("Cart.vue#Cart.items");
    expect(items?.kind).toBe("computed");
    expect(items?.classification).toBe("derived");
    // The template reaches it through the RETURNED name.
    expect(
      graph.edges.some(
        (e) => e.type === "reads" && e.to === "Cart.vue#Cart.items",
      ),
    ).toBe(true);
  });

  it("classifies a setup() ref fed by onMounted+fetch as a hand-rolled server cache", () => {
    const findings = runStatelinter([
      {
        path: "Profile.vue",
        code: OPTIONS_SFC(`
import { ref, onMounted } from 'vue';
export default {
  setup() {
    const user = ref(null);
    onMounted(async () => {
      const res = await fetch('/api/user');
      user.value = await res.json();
    });
    return { user };
  },
};
`),
      },
    ]);
    const finding = findings.find(
      (f) => f.rule === "server-state-in-client-state",
    );
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("lives in ref");
  });

  it("detects a drill chain through a setup()-option middle component", () => {
    const origin = `<template>
  <AppLayout :user="user" />
</template>
<script setup lang="ts">
import { ref } from 'vue';
import AppLayout from './AppLayout.vue';
const user = ref({ name: 'Ada' });
</script>
`;
    const layout = `<template>
  <div class="layout"><SetupMiddle :user="user" /></div>
</template>
<script setup lang="ts">
import SetupMiddle from './SetupMiddle.vue';
defineProps<{ user: { name: string } }>();
</script>
`;
    const setupMiddle = `<template>
  <ProfileCard :user="user" />
</template>
<script lang="ts">
import ProfileCard from './ProfileCard.vue';
export default {
  components: { ProfileCard },
  props: ['user'],
  setup() {
    return {};
  },
};
</script>
`;
    const leaf = `<template>
  <span>{{ user.name }}</span>
</template>
<script setup lang="ts">
defineProps<{ user: { name: string } }>();
</script>
`;
    const findings = runStatelinter([
      { path: "App.vue", code: origin },
      { path: "AppLayout.vue", code: layout },
      { path: "SetupMiddle.vue", code: setupMiddle },
      { path: "ProfileCard.vue", code: leaf },
    ]);
    const finding = findings.find((f) => f.rule === "prop-drilling");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("AppLayout → SetupMiddle");
  });

  it("setup(props) member access counts as a prop read (not a blind forward)", () => {
    const graph = buildStateGraph([
      {
        path: "App.vue",
        code: SFC(
          `\nimport { ref } from 'vue';\nimport Card from './Card.vue';\nconst user = ref({});\n`,
          `<Card :user="user" />`,
        ),
      },
      {
        path: "Card.vue",
        code: OPTIONS_SFC(
          `
import { computed } from 'vue';
export default {
  props: ['user'],
  setup(props) {
    const label = computed(() => props.user.name);
    return { label };
  },
};
`,
          `<b>{{ label }}</b>`,
        ),
      },
    ]);
    const pass = graph.edges.find((e) => e.type === "passesProp");
    expect(pass).toMatchObject({ prop: "user", reads: true });
  });

  it("setup({ destructured }) props usage counts as a prop read too", () => {
    const graph = buildStateGraph([
      {
        path: "App.vue",
        code: SFC(
          `\nimport { ref } from 'vue';\nimport Card from './Card.vue';\nconst user = ref({});\n`,
          `<Card :user="user" />`,
        ),
      },
      {
        path: "Card.vue",
        code: OPTIONS_SFC(`
export default {
  props: ['user'],
  setup({ user }) {
    return { greeting: user };
  },
};
`),
      },
    ]);
    const pass = graph.edges.find((e) => e.type === "passesProp");
    expect(pass).toMatchObject({ prop: "user", reads: true });
  });

  it("setup()-returned names shadow data() names in the template (Vue precedence)", () => {
    const graph = buildStateGraph([
      {
        path: "Page.vue",
        code: OPTIONS_SFC(
          `
import { ref } from 'vue';
export default {
  data() {
    return { title: 'from-data' };
  },
  setup() {
    const title = ref('from-setup');
    return { title };
  },
};
`,
          `<h1>{{ title }}</h1>`,
        ),
      },
    ]);
    // Name collision resolves to the setup binding — the ref wins the source.
    const title = graph.sources.get("Page.vue#Page.title");
    expect(title?.kind).toBe("ref");
    expect(
      graph.edges.some(
        (e) => e.type === "reads" && e.to === "Page.vue#Page.title",
      ),
    ).toBe(true);
    expect(graph.unresolved.optionsComponents).toBe(0);
  });
});

describe("Vue — pinia map helpers (Options API)", () => {
  it("mapStores reads via hook, mapActions writes via setState", () => {
    const graph = buildStateGraph([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
import { mapStores, mapActions } from 'pinia';
import { useCartStore } from './stores/cart';
export default {
  computed: {
    ...mapStores(useCartStore),
  },
  methods: {
    ...mapActions(useCartStore, ['addItem']),
  },
};
`),
      },
    ]);
    const kinds = graph.edges
      .filter((e) => e.to === "pinia:cart")
      .map((e) => `${e.type}:${"via" in e ? e.via : ""}`);
    expect(kinds).toContain("reads:hook");
    expect(kinds).toContain("writes:setState");
    expect(graph.unresolved.optionsComponents).toBe(0);
  });

  it("mapState (array form) reads via selector", () => {
    const graph = buildStateGraph([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
import { mapState } from 'pinia';
import { useCartStore } from './stores/cart';
export default {
  computed: {
    ...mapState(useCartStore, ['items']),
  },
};
`),
      },
    ]);
    expect(
      graph.edges.some(
        (e) =>
          e.type === "reads" && e.to === "pinia:cart" && e.via === "selector",
      ),
    ).toBe(true);
  });

  it("mapGetters (object form second arg) reads via selector", () => {
    const graph = buildStateGraph([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
import { mapGetters } from 'pinia';
import { useCartStore } from './stores/cart';
export default {
  computed: {
    ...mapGetters(useCartStore, { count: 'itemCount' }),
  },
};
`),
      },
    ]);
    expect(
      graph.edges.some(
        (e) =>
          e.type === "reads" && e.to === "pinia:cart" && e.via === "selector",
      ),
    ).toBe(true);
  });

  it("mapWritableState reads via selector AND writes via mutate", () => {
    const graph = buildStateGraph([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
import { mapWritableState } from 'pinia';
import { useCartStore } from './stores/cart';
export default {
  computed: {
    ...mapWritableState(useCartStore, ['coupon']),
  },
};
`),
      },
    ]);
    const kinds = graph.edges
      .filter((e) => e.to === "pinia:cart")
      .map((e) => `${e.type}:${"via" in e ? e.via : ""}`);
    expect(kinds).toContain("reads:selector");
    expect(kinds).toContain("writes:mutate");
  });

  it("map helpers from a non-pinia module produce no edges", () => {
    const graph = buildStateGraph([
      { path: "stores/cart.ts", code: CART_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
import { mapState } from './my-helpers';
import { useCartStore } from './stores/cart';
export default {
  computed: {
    ...mapState(useCartStore, ['items']),
  },
};
`),
      },
    ]);
    expect(
      graph.edges.some(
        (e) =>
          e.type === "reads" && e.to === "pinia:cart" && e.via === "selector",
      ),
    ).toBe(false);
  });
});

describe("Vue — local mixins", () => {
  it("merges an in-file mixin's data(): source registered, this.x edges attach", () => {
    const graph = buildStateGraph([
      {
        path: "Counter.vue",
        code: OPTIONS_SFC(`
const counterMixin = {
  data() {
    return { count: 0 };
  },
};
export default {
  mixins: [counterMixin],
  methods: {
    bump() { this.count = this.count + 1; },
  },
};
`),
      },
    ]);
    expect(graph.unresolved.optionsComponents).toBe(0);
    const count = graph.sources.get("Counter.vue#Counter.count");
    expect(count?.kind).toBe("options-data");
    expect(
      graph.edges.some((e) => e.type === "reads" && e.to === count?.id),
    ).toBe(true);
    expect(
      graph.edges.some((e) => e.type === "writes" && e.to === count?.id),
    ).toBe(true);
  });

  it("merges a mixin imported as a default-export object literal from an analyzed file", () => {
    const graph = buildStateGraph([
      {
        path: "mixins/theme.ts",
        code: `export default {\n  data() {\n    return { theme: 'dark' };\n  },\n};\n`,
      },
      {
        path: "Page.vue",
        code: OPTIONS_SFC(
          `
import themeMixin from './mixins/theme';
export default {
  mixins: [themeMixin],
};
`,
          `<div :class="theme" />`,
        ),
      },
    ]);
    expect(graph.unresolved.optionsComponents).toBe(0);
    const theme = graph.sources.get("Page.vue#Page.theme");
    expect(theme?.kind).toBe("options-data");
    expect(
      graph.edges.some((e) => e.type === "reads" && e.to === theme?.id),
    ).toBe(true);
  });

  it("merges a named-export mixin object literal too", () => {
    const graph = buildStateGraph([
      {
        path: "mixins/base.ts",
        code: `export const baseMixin = {\n  data() {\n    return { open: false };\n  },\n};\n`,
      },
      {
        path: "Panel.vue",
        code: OPTIONS_SFC(`
import { baseMixin } from './mixins/base';
export default {
  mixins: [baseMixin],
};
`),
      },
    ]);
    expect(graph.unresolved.optionsComponents).toBe(0);
    expect(graph.sources.get("Panel.vue#Panel.open")?.kind).toBe(
      "options-data",
    );
  });

  it("a package-import mixin keeps the component counted unresolved", () => {
    const graph = buildStateGraph([
      {
        path: "Form.vue",
        code: OPTIONS_SFC(`
import validationMixin from 'vuelidate';
export default {
  mixins: [validationMixin],
  data() {
    return { email: '' };
  },
};
`),
      },
    ]);
    expect(graph.unresolved.optionsComponents).toBe(1);
  });
});

describe("Vue — Vuex adapter", () => {
  /** Root state + one namespaced module — the classic layout. */
  const VUEX_STORE = `
import { createStore } from 'vuex';

export default createStore({
  state: { user: null, locale: 'en' },
  modules: {
    cart: {
      namespaced: true,
      state: () => ({ items: [], coupon: null }),
    },
  },
});
`;

  it("registers vuex:root and vuex:<module> sources with fields", () => {
    const graph = buildStateGraph([
      { path: "store/index.ts", code: VUEX_STORE },
    ]);
    const root = graph.sources.get("vuex:root");
    const cart = graph.sources.get("vuex:cart");
    expect(root?.kind).toBe("vuex");
    expect(root?.classification).toBe("global-client");
    expect(root?.shape?.fields).toEqual(["user", "locale"]);
    expect(cart?.kind).toBe("vuex");
    expect(cart?.shape?.fields).toEqual(["items", "coupon"]);
  });

  it("attributes $store.state/getters reads to the module when the first segment names one, else root", () => {
    const graph = buildStateGraph([
      { path: "store/index.ts", code: VUEX_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
export default {
  computed: {
    items() { return this.$store.state.cart.items; },
    // bare state.user — 'user' names no module, so it falls back to root.
    user() { return this.$store.state.user; },
    who() { return this.$store.getters.user; },
  },
};
`),
      },
    ]);
    expect(graph.unresolved.optionsComponents).toBe(0);
    expect(
      graph.edges.some(
        (e) =>
          e.type === "reads" && e.to === "vuex:cart" && e.via === "selector",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) =>
          e.type === "reads" && e.to === "vuex:root" && e.via === "selector",
      ),
    ).toBe(true);
  });

  it("commit/dispatch are writes via dispatch, attributed by the literal's namespace segment", () => {
    const graph = buildStateGraph([
      { path: "store/index.ts", code: VUEX_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
export default {
  methods: {
    add(item) { this.$store.commit('cart/add', item); },
    login() { this.$store.dispatch('login'); },
  },
};
`),
      },
    ]);
    expect(
      graph.edges.some(
        (e) =>
          e.type === "writes" && e.to === "vuex:cart" && e.via === "dispatch",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) =>
          e.type === "writes" && e.to === "vuex:root" && e.via === "dispatch",
      ),
    ).toBe(true);
  });

  it("vuex map helpers attribute by namespace-string first arg", () => {
    const graph = buildStateGraph([
      { path: "store/index.ts", code: VUEX_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
import { mapState, mapActions } from 'vuex';
export default {
  computed: {
    ...mapState('cart', ['items']),
  },
  methods: {
    ...mapActions('cart', ['add']),
  },
};
`),
      },
    ]);
    const kinds = graph.edges
      .filter((e) => e.to === "vuex:cart")
      .map((e) => `${e.type}:${"via" in e ? e.via : ""}`);
    expect(kinds).toContain("reads:selector");
    expect(kinds).toContain("writes:dispatch");
  });

  it("Composition useStore() from vuex reads vuex:root via hook", () => {
    const graph = buildStateGraph([
      { path: "store/index.ts", code: VUEX_STORE },
      {
        path: "Header.vue",
        code: SFC(`
import { useStore } from 'vuex';
const store = useStore();
`),
      },
    ]);
    expect(
      graph.edges.some(
        (e) => e.type === "reads" && e.to === "vuex:root" && e.via === "hook",
      ),
    ).toBe(true);
  });

  it("over-globalized fires on a single-reader vuex module with colocation wording", () => {
    const findings = runStatelinter([
      { path: "store/index.ts", code: VUEX_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
export default {
  computed: {
    items() { return this.$store.state.cart.items; },
  },
};
`),
      },
    ]);
    const finding = findings.find((f) => f.rule === "over-globalized-state");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain(
      "Store 'cart' is global but read by exactly one component (Cart)",
    );
    expect(finding?.recommendation).toContain(
      "local ref()s or a pinia store inside Cart",
    );
  });

  it("suppresses the vuex single-reader claim while any component is unresolved", () => {
    const findings = runStatelinter([
      { path: "store/index.ts", code: VUEX_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
export default {
  computed: {
    items() { return this.$store.state.cart.items; },
  },
};
`),
      },
      { path: "Legacy.vue", code: MIXIN_SFC },
    ]);
    expect(
      findings.filter((f) => f.rule === "over-globalized-state"),
    ).toHaveLength(0);
  });

  it("multiple-sources fires when the same entity lives in a vuex module AND a pinia store", () => {
    const findings = runStatelinter([
      { path: "store/index.ts", code: VUEX_STORE },
      { path: "stores/cart.ts", code: CART_STORE },
    ]);
    const finding = findings.find(
      (f) => f.rule === "multiple-sources-of-truth",
    );
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("vuex store 'cart'");
    expect(finding?.message).toContain("pinia store 'cart'");
  });

  it("a vuex-dominant app gets the vuex-persistedstate persist hint", () => {
    const graph = buildStateGraph([
      { path: "store/index.ts", code: VUEX_STORE },
      {
        path: "Cart.vue",
        code: OPTIONS_SFC(`
export default {
  computed: {
    items() { return this.$store.state.cart.items; },
  },
};
`),
      },
    ]);
    expect(computeStackProfile(graph).persistHint).toBe(
      "your Vuex store via vuex-persistedstate",
    );
  });
});
