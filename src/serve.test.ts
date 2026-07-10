import { mkdtempSync, writeFileSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { ansiToHtml, scan, startConsole } from "./serve.js";

const FIXTURE = `
  export function Users() {
    const [users, setUsers] = useState([]);
    useEffect(() => {
      fetch('/api/users').then((r) => r.json()).then(setUsers);
    }, []);
    return <ul>{users.length}</ul>;
  }
`;

let dir: string;
let server: Server;
let url: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "statelinter-serve-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/Users.tsx"), FIXTURE);
  // The server resolves console.html next to its own compiled file; in tests
  // (vitest runs from src/) the template already sits beside serve.ts.
  const started = await startConsole([join(dir, "src")], 0); // port 0 = ephemeral
  server = started.server;
  url = started.url;
});

afterAll(() => {
  server?.close();
});

describe("ansiToHtml", () => {
  it("converts statelinter's ANSI codes to spans and escapes HTML", () => {
    const html = ansiToHtml("\x1b[33m\x1b[1m▲ 1 problem\x1b[0m <script>");
    expect(html).toBe(
      '<span class="yellow"><span class="b">▲ 1 problem</span></span> &lt;script&gt;',
    );
  });
});

describe("scan", () => {
  it("returns findings, meta, and rendered terminal html", () => {
    const result = scan([join(dir, "src")], dir);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]!.rule).toBe("server-state-in-client-state");
    expect(result.meta.fileCount).toBe(1);
    expect(result.meta.root).toBe(dir);
    expect(result.termHtml).toContain("server-state-in-client-state");
    expect(result.termHtml).toContain('<span class="yellow">');
    // The fixture is a .tsx useState component only — payload shape check,
    // full stack-detection coverage (vue-only / mixed) lives in run.test.ts.
    expect(result.meta.stack).toEqual({ react: true, vue: false, nuxt: false });
  });
});

describe("statelinter --ui server", () => {
  it("serves the console page with embedded findings", async () => {
    const res = await fetch(url + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("statelinter");
    expect(html).toContain("server-state-in-client-state");
    expect(html).not.toContain("__FINDINGS__");
    expect(html).not.toContain("__META__");
  });

  it("re-scans on /api/scan and returns fresh JSON", async () => {
    // Add a second problem file between scans — rescan must pick it up.
    writeFileSync(
      join(dir, "src/Orders.tsx"),
      FIXTURE.replace(/Users/g, "Orders").replace(/users/g, "orders"),
    );
    const res = await fetch(url + "/api/scan");
    expect(res.status).toBe(200);
    const data = (await res.json()) as ReturnType<typeof scan>;
    expect(data.meta.fileCount).toBe(2);
    expect(data.findings.length).toBeGreaterThanOrEqual(2);
    expect(data.termHtml).toContain("Orders.tsx");
  });

  it("404s unknown routes", async () => {
    const res = await fetch(url + "/nope");
    expect(res.status).toBe(404);
  });
});

describe("statelinter --ui demos", () => {
  it("?demo=react scans the bundled React example instead of the startup paths", async () => {
    const res = await fetch(url + "/api/scan?demo=react");
    expect(res.status).toBe(200);
    const data = (await res.json()) as ReturnType<typeof scan>;
    expect(data.meta.demo).toBe("react");
    expect(data.meta.stack).toEqual({ react: true, vue: false, nuxt: false });
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
  });

  it("?demo=vue scans the bundled Vue example instead of the startup paths", async () => {
    const res = await fetch(url + "/api/scan?demo=vue");
    expect(res.status).toBe(200);
    const data = (await res.json()) as ReturnType<typeof scan>;
    expect(data.meta.demo).toBe("vue");
    expect(data.meta.stack.vue).toBe(true);
    expect(data.meta.stack.react).toBe(false);
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
  });

  it("an unknown/junk demo value falls back to the normal scan, demo null", async () => {
    const res = await fetch(url + "/api/scan?demo=../../etc");
    expect(res.status).toBe(200);
    const data = (await res.json()) as ReturnType<typeof scan>;
    expect(data.meta.demo).toBeNull();
    // Falls back to scanning the startup paths (dir/src + dir/src/Orders.tsx
    // added earlier), not the junk value — fileCount matches the normal scan.
    expect(data.meta.fileCount).toBe(2);
  });

  it("another unrecognized demo value also falls back to the normal scan", async () => {
    const res = await fetch(url + "/api/scan?demo=nuxt");
    expect(res.status).toBe(200);
    const data = (await res.json()) as ReturnType<typeof scan>;
    expect(data.meta.demo).toBeNull();
  });

  it("meta.demos reports both bundled example dirs as present", async () => {
    const res = await fetch(url + "/api/scan");
    expect(res.status).toBe(200);
    const data = (await res.json()) as ReturnType<typeof scan>;
    expect(data.meta.demos).toEqual({ react: true, vue: true });
  });

  it("GET /?demo=react renders the console page from the demo scan", async () => {
    const res = await fetch(url + "/?demo=react");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"demo":"react"');
  });
});
