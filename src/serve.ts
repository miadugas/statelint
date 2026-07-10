/**
 * statelinter --ui — serves the findings console locally and re-runs the
 * analysis on demand. Rescan is one click: GET /api/scan re-scans the same
 * paths in-process and returns fresh findings + rendered terminal output.
 * Binds 127.0.0.1 only; nothing leaves the machine.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceFileInput } from "./graph/build.js";
import type { Finding } from "./detectors/types.js";
import { discoverFiles } from "./discover.js";
import { formatFindings } from "./format.js";
import { runStatelinter } from "./run.js";

type DemoKey = "react" | "vue";

interface ScanResult {
  findings: Finding[];
  meta: {
    root: string;
    repo: string;
    fileCount: number;
    durationMs: number;
    command: string;
    stack: { react: boolean; vue: boolean; nuxt: boolean };
    demo: DemoKey | null;
    demos: { react: boolean; vue: boolean };
  };
  termHtml: string;
}

/**
 * Bundled example apps, viewable from the console with one click. Paths are
 * relative to the package root — examples/ sits next to both src/ (dev, via
 * tsx) and dist/ (built), and serve.ts lives in one or the other, so
 * resolving against import.meta.url of *this* file lands on the right
 * examples/ dir either way.
 *
 * STRICT whitelist: these are the only two demo values ever accepted. The
 * `demo` query param is checked for exact equality against these keys before
 * it touches the filesystem — it is never concatenated into a path itself,
 * so there is no traversal surface here.
 */
const DEMOS: Record<DemoKey, string> = {
  react: "examples/react-app",
  vue: "examples/vue-app",
};

function demoDir(key: DemoKey): string {
  return fileURLToPath(new URL(`../${DEMOS[key]}`, import.meta.url));
}

function demosAvailable(): { react: boolean; vue: boolean } {
  return {
    react: existsSync(demoDir("react")),
    vue: existsSync(demoDir("vue")),
  };
}

/**
 * Validate a caller-supplied `demo` param against the whitelist and confirm
 * the target dir actually exists on disk right now. Anything else (missing
 * param, unknown value, path traversal junk, a dir that isn't there) returns
 * null — the caller falls back to the normal startup-path scan.
 */
function resolveDemo(
  param: string | null,
): { key: DemoKey; dir: string } | null {
  if (param !== "react" && param !== "vue") return null;
  const dir = demoDir(param);
  if (!existsSync(dir)) return null;
  return { key: param, dir };
}

/** Convert statelinter's own ANSI output (codes 0/1/2/31/32/33/36) to spans. */
export function ansiToHtml(text: string): string {
  const CLASSES: Record<string, string> = {
    "1": "b",
    "2": "d",
    "31": "red",
    "32": "green",
    "33": "yellow",
    "36": "cyan",
  };
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let out = "";
  let open = 0;
  for (const part of text.split(/(\x1b\[\d+m)/)) {
    const match = /^\x1b\[(\d+)m$/.exec(part);
    if (!match) {
      out += escape(part);
      continue;
    }
    if (match[1] === "0") {
      out += "</span>".repeat(open);
      open = 0;
    } else if (match[1] && CLASSES[match[1]]) {
      out += `<span class="${CLASSES[match[1]]}">`;
      open++;
    }
  }
  return out + "</span>".repeat(open);
}

export function scan(
  paths: string[],
  cwd: string,
  demo: DemoKey | null = null,
): ScanResult {
  const started = performance.now();
  const files: SourceFileInput[] = [];
  for (const path of paths) discoverFiles(path, files);
  let stack = { react: false, vue: false, nuxt: false };
  const findings = runStatelinter(files, {
    onParseError: () => {},
    onMeta: (meta) => {
      stack = meta.stack;
    },
  });
  const durationMs = performance.now() - started;

  const pretty = formatFindings(findings, {
    color: true,
    cwd,
    width: 100,
    fileCount: files.length,
    durationMs,
  });

  return {
    findings,
    meta: {
      root: cwd,
      repo: basename(cwd),
      fileCount: files.length,
      durationMs: Math.round(durationMs),
      command: `statelinter ${demo ? DEMOS[demo] : paths.join(" ")}`,
      stack,
      demo,
      demos: demosAvailable(),
    },
    termHtml: ansiToHtml(pretty),
  };
}

function composePage(result: ScanResult): string {
  const template = readFileSync(
    new URL("./console.html", import.meta.url),
    "utf8",
  );
  const embed = (value: unknown) =>
    JSON.stringify(value).replace(/<\//g, "<\\/");
  return template
    .replace("__REPO__", result.meta.repo)
    .replace("__FINDINGS__", embed(result.findings))
    .replace("__META__", embed(result.meta))
    .replace("__TERM__", embed(result.termHtml));
}

/**
 * Scan for one incoming request: honors ?demo=react|vue against the strict
 * whitelist in resolveDemo, scanning that example dir instead of the
 * caller's startup paths. Any other value (missing dir, unknown key, path
 * traversal junk) is ignored and falls back to the normal scan — the query
 * param is never used to build a filesystem path itself.
 */
function scanForRequest(url: URL, paths: string[], cwd: string): ScanResult {
  const demo = resolveDemo(url.searchParams.get("demo"));
  if (demo) return scan([demo.dir], demo.dir, demo.key);
  return scan(paths, cwd, null);
}

export function startConsole(
  paths: string[],
  port: number,
): Promise<{ server: Server; url: string }> {
  const cwd = resolve(process.cwd());

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(composePage(scanForRequest(url, paths, cwd)));
        return;
      }
      if (url.pathname === "/api/scan") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(scanForRequest(url, paths, cwd)));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(error instanceof Error ? error.message : "scan failed");
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort =
        typeof address === "object" && address ? address.port : port;
      resolvePromise({ server, url: `http://localhost:${actualPort}` });
    });
  });
}
