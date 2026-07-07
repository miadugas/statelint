#!/usr/bin/env node
/**
 * statelint CLI — `statelint [paths...] [--min-drill N] [--json] [--no-color] [--ui]`
 * Exit 1 on warnings/errors (the CI gate); advisory info findings exit 0.
 * --ui serves the findings console locally with one-click rescan.
 */

import type { SourceFileInput } from "./graph/build.js";
import { discoverFiles } from "./discover.js";
import { exitCode, formatFindings } from "./format.js";
import { runStatelint } from "./run.js";
import { startConsole } from "./serve.js";

interface CliArgs {
  paths: string[];
  minDrill: number | undefined;
  json: boolean;
  help: boolean;
  noColor: boolean;
  ui: boolean;
  port: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    paths: [],
    minDrill: undefined,
    json: false,
    help: false,
    noColor: false,
    ui: false,
    port: 8734,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--json") args.json = true;
    else if (arg === "--no-color") args.noColor = true;
    else if (arg === "--ui") args.ui = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--port") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        console.error("statelint: --port expects a port number");
        process.exit(2);
      }
      args.port = value;
    } else if (arg === "--min-drill") {
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: statelint [paths...] [options]\n\n" +
        "Options:\n" +
        "  --ui            serve the findings console locally (one-click rescan)\n" +
        "  --port N        console port (default 8734)\n" +
        "  --min-drill N   prop-drilling threshold (blind intermediates, default 2)\n" +
        "  --json          machine-readable output\n" +
        "  --no-color      disable colored output (also honors NO_COLOR)\n" +
        "  -h, --help      show this help\n\n" +
        "Exit codes: 0 clean or info-only, 1 warnings/errors, 2 usage error",
    );
    return;
  }

  if (args.ui) {
    const { url } = await startConsole(args.paths, args.port);
    console.log(`statelint console → ${url}`);
    console.log(
      `  watching: ${args.paths.join(", ")} — hit Rescan in the browser after edits; Ctrl+C to stop`,
    );
    return; // server keeps the process alive
  }

  const started = performance.now();
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
  const durationMs = performance.now() - started;

  if (args.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    const color =
      !args.noColor &&
      process.stdout.isTTY === true &&
      process.env["NO_COLOR"] === undefined;
    console.log(
      formatFindings(findings, {
        color,
        cwd: process.cwd(),
        width: Math.min(process.stdout.columns ?? 80, 100),
        fileCount: files.length,
        durationMs,
      }),
    );
  }

  // Never process.exit() after writing: it kills pending async stdout writes
  // and truncates piped --json output. exitCode lets the stream drain.
  process.exitCode = exitCode(findings);
}

void main();
