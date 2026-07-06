#!/usr/bin/env node
/**
 * statelint CLI — `statelint [paths...] [--min-drill N] [--json]`
 * Exit code 1 when findings exist (the CI gate), 0 when clean.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { SourceFileInput } from "./graph/build.js";
import type { Finding } from "./detectors/types.js";
import { runStatelint } from "./run.js";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
]);
const EXTENSIONS = new Set([".tsx", ".jsx", ".ts"]);

interface CliArgs {
  paths: string[];
  minDrill: number | undefined;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    paths: [],
    minDrill: undefined,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--min-drill") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        console.error("statelint: --min-drill expects a positive integer");
        process.exit(2);
      }
      args.minDrill = value;
    } else args.paths.push(arg);
  }
  if (args.paths.length === 0) args.paths.push(".");
  return args;
}

function discoverFiles(root: string, out: SourceFileInput[]): void {
  const stats = statSync(root);
  if (stats.isFile()) {
    if (EXTENSIONS.has(extname(root)))
      out.push({ path: root, code: readFileSync(root, "utf8") });
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        discoverFiles(join(root, entry.name), out);
      }
    } else if (EXTENSIONS.has(extname(entry.name))) {
      const path = join(root, entry.name);
      out.push({ path, code: readFileSync(path, "utf8") });
    }
  }
}

function printPretty(findings: Finding[]): void {
  let currentFile = "";
  for (const finding of findings) {
    if (finding.loc.file !== currentFile) {
      currentFile = finding.loc.file;
      console.log(`\n${currentFile}`);
    }
    console.log(
      `  ${finding.loc.line}:${finding.loc.col}  ${finding.severity}  ${finding.rule}  ${finding.message}`,
    );
    console.log(`         ↳ ${finding.recommendation}`);
  }
  const label = findings.length === 1 ? "problem" : "problems";
  console.log(
    `\n${findings.length === 0 ? "✓ no" : `✖ ${findings.length}`} ${label}`,
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: statelint [paths...] [options]\n\n" +
        "Options:\n" +
        "  --min-drill N   prop-drilling threshold (blind intermediates, default 2)\n" +
        "  --json          machine-readable output\n" +
        "  -h, --help      show this help",
    );
    return;
  }

  const files: SourceFileInput[] = [];
  for (const path of args.paths) {
    discoverFiles(path, files);
  }
  if (files.length === 0) {
    console.error("statelint: no .tsx/.jsx/.ts files found");
    process.exit(2);
  }

  const findings = runStatelint(files, {
    minBlindIntermediates: args.minDrill,
    onParseError: (path, error) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`statelint: skipped ${path} (parse error: ${reason})`);
    },
  });

  if (args.json) console.log(JSON.stringify(findings, null, 2));
  else printPretty(findings);

  process.exit(findings.length > 0 ? 1 : 0);
}

main();
