import { describe, expect, it } from "vitest";
import { buildStateGraph } from "./build.js";
import { detectCookieAsState } from "../detectors/cookie-as-state.js";
import { detectMultipleSourcesOfTruth } from "../detectors/multiple-sources.js";

describe("cookie adapter", () => {
  it("registers js-cookie get/set as raw reads/writes", () => {
    const graph = buildStateGraph([
      {
        path: "src/Auth.tsx",
        code: `
          import Cookies from 'js-cookie';
          export function Auth() {
            const token = Cookies.get('token');
            const logout = () => Cookies.remove('token');
            return <button onClick={logout}>{token ? 'out' : 'in'}</button>;
          }
        `,
      },
    ]);
    const source = graph.sources.get("cookie:token");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("cookie");
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/Auth.tsx#Auth",
      to: "cookie:token",
      via: "hook",
    });
    expect(graph.edges).toContainEqual({
      type: "writes",
      from: "src/Auth.tsx#Auth",
      to: "cookie:token",
      via: "mutate",
    });
  });

  it("registers react-cookie useCookies as reactive reads/writes", () => {
    const graph = buildStateGraph([
      {
        path: "src/Consent.tsx",
        code: `
          import { useCookies } from 'react-cookie';
          export function Consent() {
            const [cookies, setCookie] = useCookies(['consent']);
            return (
              <button onClick={() => setCookie('consent', 'yes')}>
                {cookies.consent}
              </button>
            );
          }
        `,
      },
    ]);
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/Consent.tsx#Consent",
      to: "cookie:consent",
      via: "context",
    });
    expect(graph.edges).toContainEqual({
      type: "writes",
      from: "src/Consent.tsx#Consent",
      to: "cookie:consent",
      via: "setter",
    });
  });

  it("parses document.cookie literal writes and skips dynamic ones", () => {
    const graph = buildStateGraph([
      {
        path: "src/Theme.tsx",
        code: `
          export function Theme({ dynamicName }) {
            const set = () => {
              document.cookie = "theme=dark; path=/";
              document.cookie = dynamicName + "=x";
            };
            return <button onClick={set}>dark</button>;
          }
        `,
      },
    ]);
    expect(graph.sources.get("cookie:theme")?.kind).toBe("cookie");
    expect(graph.sources.size).toBe(1); // dynamic write registered nothing
  });

  it("attributes cookie access through custom hooks", () => {
    const graph = buildStateGraph([
      {
        path: "src/useAuthToken.ts",
        code: `
          import Cookies from 'js-cookie';
          export function useAuthToken() {
            return Cookies.get('auth_token');
          }
        `,
      },
      {
        path: "src/Header.tsx",
        code: `
          import { useAuthToken } from './useAuthToken';
          export function Header() {
            const token = useAuthToken();
            return token ? <nav /> : null;
          }
        `,
      },
    ]);
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/Header.tsx#Header",
      to: "cookie:auth_token",
      via: "hook",
    });
  });
});

describe("detectCookieAsState", () => {
  it("warns when js-cookie shares a written cookie across components", () => {
    const graph = buildStateGraph([
      {
        path: "src/Login.tsx",
        code: `
          import Cookies from 'js-cookie';
          export function Login() {
            return <button onClick={() => Cookies.set('session', 'abc')}>Go</button>;
          }
        `,
      },
      {
        path: "src/Gate.tsx",
        code: `
          import Cookies from 'js-cookie';
          export function Gate() {
            return Cookies.get('session') ? <main /> : <p>locked</p>;
          }
        `,
      },
    ]);
    const findings = detectCookieAsState(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("'session'");
    expect(findings[0]!.message).toContain("isn't reactive");
  });

  it("calls out mixed reactive + raw access explicitly", () => {
    const graph = buildStateGraph([
      {
        path: "src/Banner.tsx",
        code: `
          import { useCookies } from 'react-cookie';
          export function Banner() {
            const [cookies] = useCookies(['consent']);
            return cookies.consent ? null : <div>banner</div>;
          }
        `,
      },
      {
        path: "src/Accept.tsx",
        code: `
          import Cookies from 'js-cookie';
          export function Accept() {
            return <button onClick={() => Cookies.set('consent', 'yes')}>OK</button>;
          }
        `,
      },
    ]);
    const findings = detectCookieAsState(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(
      "mixes react-cookie with raw access",
    );
  });

  it("stays quiet when everything goes through react-cookie", () => {
    const component = (name: string, action: string) => `
      import { useCookies } from 'react-cookie';
      export function ${name}() {
        const [cookies, setCookie] = useCookies(['consent']);
        return <button onClick={() => ${action}>{cookies.consent}</button>;
      }
    `;
    const graph = buildStateGraph([
      {
        path: "src/A.tsx",
        code: component("A", "setCookie('consent', 'yes')}"),
      },
      {
        path: "src/B.tsx",
        code: component("B", "setCookie('consent', 'no')}"),
      },
    ]);
    expect(detectCookieAsState(graph)).toHaveLength(0);
  });

  it("recommends Vue wording, never react-cookie, when two .vue SFCs share a cookie", () => {
    const graph = buildStateGraph([
      {
        path: "src/Login.vue",
        code: `<template>
  <button @click="login">Go</button>
</template>
<script setup lang="ts">
import Cookies from 'js-cookie';
const login = () => Cookies.set('session', 'abc');
</script>
`,
      },
      {
        path: "src/Gate.vue",
        code: `<template>
  <main v-if="token" />
  <p v-else>locked</p>
</template>
<script setup lang="ts">
import Cookies from 'js-cookie';
const token = Cookies.get('session');
</script>
`,
      },
    ]);
    const findings = detectCookieAsState(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.recommendation).not.toContain("react-cookie");
    expect(findings[0]!.recommendation).toContain("pinia store or composable");
  });

  it("uses neutral wording when a cookie is shared across a mixed React + Vue pair", () => {
    const graph = buildStateGraph([
      {
        path: "src/Login.tsx",
        code: `
          import Cookies from 'js-cookie';
          export function Login() {
            return <button onClick={() => Cookies.set('session', 'abc')}>Go</button>;
          }
        `,
      },
      {
        path: "src/Gate.vue",
        code: `<template>
  <main v-if="token" />
</template>
<script setup lang="ts">
import Cookies from 'js-cookie';
const token = Cookies.get('session');
</script>
`,
      },
    ]);
    const findings = detectCookieAsState(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.recommendation).not.toContain("react-cookie");
    expect(findings[0]!.recommendation).not.toContain("pinia");
    expect(findings[0]!.recommendation).toContain("hook/composable");
  });

  it("keeps react-cookie wording for an all-React finding", () => {
    const graph = buildStateGraph([
      {
        path: "src/Login.tsx",
        code: `
          import Cookies from 'js-cookie';
          export function Login() {
            return <button onClick={() => Cookies.set('session', 'abc')}>Go</button>;
          }
        `,
      },
      {
        path: "src/Gate.tsx",
        code: `
          import Cookies from 'js-cookie';
          export function Gate() {
            return Cookies.get('session') ? <main /> : <p>locked</p>;
          }
        `,
      },
    ]);
    const findings = detectCookieAsState(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.recommendation).toContain("react-cookie");
  });

  it("stays quiet for single-owner cookies", () => {
    const graph = buildStateGraph([
      {
        path: "src/Only.tsx",
        code: `
          import Cookies from 'js-cookie';
          export function Only() {
            const seen = Cookies.get('tour_seen');
            return <button onClick={() => Cookies.set('tour_seen', '1')}>{seen}</button>;
          }
        `,
      },
    ]);
    expect(detectCookieAsState(graph)).toHaveLength(0);
  });
});

describe("multiple-sources-of-truth — cookies join the global kinds", () => {
  it("flags a zustand store competing with a cookie", () => {
    const graph = buildStateGraph([
      {
        path: "src/sessionStore.ts",
        code: `
          import { create } from 'zustand';
          export const useSessionStore = create(() => ({ session: null }));
        `,
      },
      {
        path: "src/Login.tsx",
        code: `
          import Cookies from 'js-cookie';
          export function Login() {
            return <button onClick={() => Cookies.set('session', 'abc')}>Go</button>;
          }
        `,
      },
    ]);
    const findings = detectMultipleSourcesOfTruth(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("cookie 'session'");
    expect(findings[0]!.message).toContain("useSessionStore");
  });
});
