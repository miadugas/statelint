import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

/**
 * DOM-level coverage for console.html's inline <script>. We load the raw
 * template, substitute the four placeholders exactly the way serve.ts's
 * composePage does (embed = JSON.stringify + "</" escape), then let JSDOM
 * execute the inline script so we assert on the real rendered DOM.
 */

const TEMPLATE = readFileSync(
  new URL("./console.html", import.meta.url),
  "utf8",
);

// Mirror of composePage's embed() in serve.ts — kept honest to the server.
const embed = (value: unknown) => JSON.stringify(value).replace(/<\//g, "<\\/");

interface TestFinding {
  rule: string;
  severity: "error" | "warn" | "info";
  message: string;
  loc: { file: string; line: number; col: number };
  recommendation: string;
}

interface LoadOptions {
  stack: { react: boolean; vue: boolean; nuxt?: boolean };
  findings?: TestFinding[];
  storedAccent?: string;
  storedDocsCollapsed?: string;
  demo?: "react" | "vue" | null;
  demos?: { react: boolean; vue: boolean };
}

function loadConsole({
  stack,
  findings = [],
  storedAccent,
  storedDocsCollapsed,
  demo = null,
  demos = { react: false, vue: false },
}: LoadOptions) {
  const meta = {
    root: "/repo",
    repo: "demo-app",
    fileCount: 12,
    durationMs: 1234,
    command: "statelinter src",
    stack: { react: stack.react, vue: stack.vue, nuxt: stack.nuxt ?? false },
    demo,
    demos,
  };

  const html = TEMPLATE.replace("__REPO__", meta.repo)
    .replace("__FINDINGS__", embed(findings))
    .replace("__META__", embed(meta))
    .replace("__TERM__", embed('<span class="prompt">demo</span>'));

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost/",
    beforeParse(window) {
      // jsdom lacks matchMedia; the theme system calls it at load.
      window.matchMedia = (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent() {
            return false;
          },
        }) as unknown as MediaQueryList;

      if (storedAccent !== undefined) {
        window.localStorage.setItem("statelinter-accent", storedAccent);
      }

      if (storedDocsCollapsed !== undefined) {
        window.localStorage.setItem(
          "statelinter-docs-collapsed",
          storedDocsCollapsed,
        );
      }
    },
  });

  const { window } = dom;
  return {
    window,
    document: window.document,
    root: window.document.documentElement,
  };
}

describe("console.html — stack-conditional docs visibility", () => {
  it("react-only: hides vue rows + all notes, forces react accent", () => {
    const { document, root } = loadConsole({
      stack: { react: true, vue: false },
    });

    const vueEls = [...document.querySelectorAll('[data-stack="vue"]')];
    const reactEls = [...document.querySelectorAll('[data-stack="react"]')];
    expect(vueEls.length).toBeGreaterThan(0);
    expect(reactEls.length).toBeGreaterThan(0);
    expect(vueEls.every((el) => el.classList.contains("stack-hidden"))).toBe(
      true,
    );
    expect(reactEls.some((el) => el.classList.contains("stack-hidden"))).toBe(
      false,
    );

    const notes = [...document.querySelectorAll("[data-stack-note]")];
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((el) => el.classList.contains("stack-hidden"))).toBe(
      true,
    );

    expect(root.dataset.accent).toBe("react");

    const vueBtn = document.querySelector(
      '[data-accent-pick="vue"]',
    ) as HTMLButtonElement;
    const reactBtn = document.querySelector(
      '[data-accent-pick="react"]',
    ) as HTMLButtonElement;
    expect(vueBtn.disabled).toBe(true);
    expect(vueBtn.getAttribute("aria-disabled")).toBe("true");
    expect(vueBtn.getAttribute("title")).toBeTruthy();
    expect(reactBtn.disabled).toBe(false);
    expect(reactBtn.getAttribute("aria-disabled")).toBe("false");
  });

  it("vue-only + stored react pref: forced accent beats pref, pref not deleted", () => {
    const { document, root, window } = loadConsole({
      stack: { react: false, vue: true },
      storedAccent: "react",
    });

    expect(root.dataset.accent).toBe("vue");

    const reactBtn = document.querySelector(
      '[data-accent-pick="react"]',
    ) as HTMLButtonElement;
    expect(reactBtn.disabled).toBe(true);
    expect(reactBtn.getAttribute("aria-disabled")).toBe("true");

    // Mismatched pref is ignored on a single-stack repo, not deleted.
    expect(window.localStorage.getItem("statelinter-accent")).toBe("react");
  });

  it("unknown stack: nothing hidden, both accent buttons enabled", () => {
    const { document } = loadConsole({ stack: { react: false, vue: false } });

    const hidden = document.querySelectorAll(".stack-hidden");
    expect(hidden.length).toBe(0);

    const notes = [...document.querySelectorAll("[data-stack-note]")];
    expect(notes.every((el) => !el.classList.contains("stack-hidden"))).toBe(
      true,
    );

    const vueBtn = document.querySelector(
      '[data-accent-pick="vue"]',
    ) as HTMLButtonElement;
    const reactBtn = document.querySelector(
      '[data-accent-pick="react"]',
    ) as HTMLButtonElement;
    expect(vueBtn.disabled).toBe(false);
    expect(reactBtn.disabled).toBe(false);
  });

  it("unknown stack + stored vue pref: pref wins on blended/unknown", () => {
    const { root } = loadConsole({
      stack: { react: false, vue: false },
      storedAccent: "vue",
    });
    expect(root.dataset.accent).toBe("vue");
  });
});

describe("console.html — banner priority note", () => {
  const finding = (severity: TestFinding["severity"]): TestFinding => ({
    rule: "multiple-sources-of-truth",
    severity,
    message: "user owned by store and context",
    loc: { file: "src/store.ts", line: 3, col: 5 },
    recommendation: "pick one owner",
  });

  it("a High (error) finding → 'Fix High findings before merging.'", () => {
    const { document } = loadConsole({
      stack: { react: true, vue: false },
      findings: [finding("error")],
    });
    const sub = document.getElementById("banner-sub")!.textContent!;
    expect(sub.endsWith("Fix High findings before merging.")).toBe(true);
  });

  it("only Medium (warn) findings → 'Review Medium findings before merging.'", () => {
    const { document } = loadConsole({
      stack: { react: true, vue: false },
      findings: [finding("warn")],
    });
    const sub = document.getElementById("banner-sub")!.textContent!;
    expect(sub.endsWith("Review Medium findings before merging.")).toBe(true);
  });

  it("no findings → 'Nothing blocking — Low findings are advisory only.'", () => {
    const { document } = loadConsole({
      stack: { react: true, vue: false },
      findings: [],
    });
    const sub = document.getElementById("banner-sub")!.textContent!;
    expect(
      sub.endsWith("Nothing blocking — Low findings are advisory only."),
    ).toBe(true);
  });
});

describe("console.html — accent picker interaction", () => {
  it("clicking an enabled button flips data-accent and persists it", () => {
    const { document, root, window } = loadConsole({
      stack: { react: false, vue: false },
    });

    expect(root.dataset.accent).toBe("react");

    const vueBtn = document.querySelector(
      '[data-accent-pick="vue"]',
    ) as HTMLButtonElement;
    vueBtn.click();

    expect(root.dataset.accent).toBe("vue");
    expect(window.localStorage.getItem("statelinter-accent")).toBe("vue");
  });
});

describe("console.html — docs section collapse", () => {
  it("default (unset pref): docs grid visible, toggle expanded", () => {
    const { document } = loadConsole({
      stack: { react: true, vue: false },
    });

    const section = document.querySelector("section.docs")!;
    const toggle = document.getElementById("docs-toggle")!;
    expect(section.classList.contains("collapsed")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking the toggle collapses the grid and persists the pref", () => {
    const { document, window } = loadConsole({
      stack: { react: true, vue: false },
    });

    const toggle = document.getElementById("docs-toggle") as HTMLButtonElement;
    toggle.click();

    const section = document.querySelector("section.docs")!;
    expect(section.classList.contains("collapsed")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("statelinter-docs-collapsed")).toBe("1");
  });

  it("stored collapsed pref: grid hidden from the start", () => {
    const { document } = loadConsole({
      stack: { react: true, vue: false },
      storedDocsCollapsed: "1",
    });

    const section = document.querySelector("section.docs")!;
    const toggle = document.getElementById("docs-toggle")!;
    expect(section.classList.contains("collapsed")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking again from a collapsed state re-expands and updates the pref", () => {
    const { document, window } = loadConsole({
      stack: { react: true, vue: false },
      storedDocsCollapsed: "1",
    });

    const toggle = document.getElementById("docs-toggle") as HTMLButtonElement;
    toggle.click();

    const section = document.querySelector("section.docs")!;
    expect(section.classList.contains("collapsed")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(window.localStorage.getItem("statelinter-docs-collapsed")).toBe("0");
  });
});

describe("console.html — Demos", () => {
  it("hides the whole Demos row when neither example dir exists", () => {
    const { document } = loadConsole({
      stack: { react: true, vue: false },
      demos: { react: false, vue: false },
    });

    expect(
      document.getElementById("demos-label")!.classList.contains("is-hidden"),
    ).toBe(true);
    expect(
      document.getElementById("demos-seg")!.classList.contains("is-hidden"),
    ).toBe(true);
  });

  it("shows the row and disables the button for the missing example", () => {
    const { document } = loadConsole({
      stack: { react: true, vue: false },
      demos: { react: true, vue: false },
    });

    expect(
      document.getElementById("demos-label")!.classList.contains("is-hidden"),
    ).toBe(false);
    expect(
      document.getElementById("demos-seg")!.classList.contains("is-hidden"),
    ).toBe(false);

    const reactBtn = document.querySelector(
      '[data-demo-pick="react"]',
    ) as HTMLButtonElement;
    const vueBtn = document.querySelector(
      '[data-demo-pick="vue"]',
    ) as HTMLButtonElement;
    expect(reactBtn.disabled).toBe(false);
    expect(vueBtn.disabled).toBe(true);
    expect(vueBtn.getAttribute("aria-disabled")).toBe("true");
  });

  it("both examples present: neither demo button is disabled", () => {
    const { document } = loadConsole({
      stack: { react: true, vue: false },
      demos: { react: true, vue: true },
    });

    const reactBtn = document.querySelector(
      '[data-demo-pick="react"]',
    ) as HTMLButtonElement;
    const vueBtn = document.querySelector(
      '[data-demo-pick="vue"]',
    ) as HTMLButtonElement;
    expect(reactBtn.disabled).toBe(false);
    expect(vueBtn.disabled).toBe(false);
  });

  it("not in demo mode: 'Your repo' control is hidden", () => {
    const { document } = loadConsole({
      stack: { react: true, vue: false },
      demos: { react: true, vue: true },
      demo: null,
    });

    const exitBtn = document.getElementById("demo-exit-btn")!;
    expect(exitBtn.classList.contains("is-hidden")).toBe(true);
  });

  it("demo mode: badge shows 'demo — <name> example' and 'Your repo' is visible", () => {
    const { document } = loadConsole({
      stack: { react: true, vue: false },
      demos: { react: true, vue: true },
      demo: "react",
    });

    expect(document.getElementById("data-badge")!.textContent).toBe(
      "demo — react example",
    );

    const exitBtn = document.getElementById("demo-exit-btn")!;
    expect(exitBtn.classList.contains("is-hidden")).toBe(false);
  });

  // Click → window.location.assign(...) wiring is not covered here: jsdom's
  // Location.assign is a non-configurable, non-writable own property in the
  // installed jsdom version (confirmed via
  // Object.getOwnPropertyDescriptor(window.location, "assign") →
  // { writable: false, configurable: false }), so it can't be spied on or
  // replaced, and calling it for real is a documented no-op ("Not
  // implemented: navigation to another Document") that never updates
  // window.location.href either. The handler itself is a one-line
  // `window.location.assign(...)` reviewed by hand; end-to-end navigation
  // was verified live against a running server (see report).
});
