/**
 * Terminal formatter — statelint's entire UI.
 *
 * Design rules: severity is never color alone (glyph + word + color);
 * hierarchy comes from weight (bold basename, dim metadata), not decoration;
 * the finding message is the only full-strength text on screen; gutters are
 * tabular so severities align; long lines soft-wrap with hanging indents.
 * Color degrades cleanly: NO_COLOR / non-TTY → plain text, same layout.
 */

import { relative } from "node:path";
import type { Finding, Severity } from "./detectors/types.js";

export interface FormatOptions {
  color: boolean;
  /** Base for relative paths; absolute paths kept when shorter. */
  cwd?: string;
  /** Soft-wrap width. Default 100. */
  width?: number;
  /** Scanned-file count for the summary line. */
  fileCount?: number;
  /** Scan duration for the summary line. */
  durationMs?: number;
}

// ─── Color tokens (the only place ANSI codes live) ───

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

type Paint = (text: string, ...codes: (keyof typeof CODES)[]) => string;

function makePaint(enabled: boolean): Paint {
  if (!enabled) return (text) => text;
  return (text, ...codes) =>
    codes.map((c) => CODES[c]).join("") + text + CODES.reset;
}

const SEVERITY = {
  error: { glyph: "✖", color: "red" },
  warn: { glyph: "▲", color: "yellow" },
  info: { glyph: "ℹ", color: "cyan" },
} as const satisfies Record<
  Severity,
  { glyph: string; color: keyof typeof CODES }
>;

// ─── Layout helpers ───

function wrap(text: string, width: number, indent: string): string {
  const usable = Math.max(width - indent.length, 20);
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length > 0 && line.length + 1 + word.length > usable) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.join(`\n${indent}`);
}

function displayPath(
  file: string,
  cwd: string | undefined,
  paint: Paint,
): string {
  let shown = file;
  if (cwd) {
    const rel = relative(cwd, file);
    if (rel.length > 0 && rel.length < file.length) shown = rel;
  }
  const slash = shown.lastIndexOf("/");
  if (slash === -1) return paint(shown, "bold");
  return (
    paint(shown.slice(0, slash + 1), "dim") +
    paint(shown.slice(slash + 1), "bold")
  );
}

// ─── Formatter ───

export function formatFindings(
  findings: Finding[],
  options: FormatOptions,
): string {
  const paint = makePaint(options.color);
  const width = options.width ?? 100;
  const out: string[] = [];

  // Group by file, preserving the sorted order runStatelint provides.
  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = byFile.get(finding.loc.file);
    if (group) group.push(finding);
    else byFile.set(finding.loc.file, [finding]);
  }

  for (const [file, group] of byFile) {
    out.push(displayPath(file, options.cwd, paint));

    const gutterWidth = Math.max(
      ...group.map((f) => `${f.loc.line}:${f.loc.col}`.length),
    );
    const indent = " ".repeat(2 + gutterWidth + 2);

    for (const finding of group) {
      const pos = `${finding.loc.line}:${finding.loc.col}`.padStart(
        gutterWidth,
      );
      const sev = SEVERITY[finding.severity];
      out.push(
        `  ${paint(pos, "dim")}  ${paint(`${sev.glyph} ${finding.severity}`, sev.color)}  ${paint(
          finding.rule,
          "dim",
        )}`,
      );
      out.push(`${indent}${wrap(finding.message, width, indent)}`);
      out.push(
        paint(
          `${indent}${wrap(`→ ${finding.recommendation}`, width, indent)}`,
          "dim",
        ),
      );
    }
    out.push("");
  }

  out.push(summaryLine(findings, paint));

  const stats: string[] = [];
  if (options.fileCount !== undefined)
    stats.push(`${options.fileCount} files scanned`);
  if (options.durationMs !== undefined)
    stats.push(`in ${(options.durationMs / 1000).toFixed(1)}s`);
  if (stats.length > 0) out.push(paint(`  ${stats.join(" ")}`, "dim"));

  return out.join("\n");
}

function summaryLine(findings: Finding[], paint: Paint): string {
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  const total = findings.length;

  if (total === 0) return paint("✓ no problems", "green", "bold");

  const parts: string[] = [];
  if (counts.error > 0)
    parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`);
  if (counts.warn > 0)
    parts.push(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`);
  if (counts.info > 0) parts.push(`${counts.info} info`);

  const worst: Severity =
    counts.error > 0 ? "error" : counts.warn > 0 ? "warn" : "info";
  const sev = SEVERITY[worst];
  const noun = total === 1 ? "problem" : "problems";
  return paint(
    `${sev.glyph} ${total} ${noun} (${parts.join(", ")})`,
    sev.color,
    "bold",
  );
}

/** Exit code semantics: advisory info findings don't fail CI; warn/error do. */
export function exitCode(findings: Finding[]): 0 | 1 {
  return findings.some((f) => f.severity !== "info") ? 1 : 0;
}
