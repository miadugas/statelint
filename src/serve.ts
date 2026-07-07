/**
 * statelint --ui — serves the findings console locally and re-runs the
 * analysis on demand. Rescan is one click: GET /api/scan re-scans the same
 * paths in-process and returns fresh findings + rendered terminal output.
 * Binds 127.0.0.1 only; nothing leaves the machine.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { SourceFileInput } from "./graph/build.js";
import type { Finding } from "./detectors/types.js";
import { discoverFiles } from "./discover.js";
import { formatFindings } from "./format.js";
import { runStatelint } from "./run.js";

interface ScanResult {
  findings: Finding[];
  meta: {
    root: string;
    repo: string;
    fileCount: number;
    durationMs: number;
    command: string;
  };
  termHtml: string;
}

/** Convert statelint's own ANSI output (codes 0/1/2/31/32/33/36) to spans. */
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

export function scan(paths: string[], cwd: string): ScanResult {
  const started = performance.now();
  const files: SourceFileInput[] = [];
  for (const path of paths) discoverFiles(path, files);
  const findings = runStatelint(files, { onParseError: () => {} });
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
      command: `statelint ${paths.join(" ")}`,
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

export function startConsole(
  paths: string[],
  port: number,
): Promise<{ server: Server; url: string }> {
  const cwd = resolve(process.cwd());

  const server = createServer((req, res) => {
    try {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(composePage(scan(paths, cwd)));
        return;
      }
      if (req.url === "/api/scan") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(scan(paths, cwd)));
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
