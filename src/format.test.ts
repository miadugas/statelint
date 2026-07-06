import { describe, expect, it } from "vitest";
import type { Finding } from "./detectors/types.js";
import { exitCode, formatFindings } from "./format.js";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  rule: "prop-drilling",
  severity: "warn",
  message: "Prop 'user' drills through 2 components.",
  recommendation: "Move this state to Context or a store.",
  loc: { file: "/repo/src/App.tsx", line: 12, col: 4 },
  ...overrides,
});

describe("formatFindings — layout (color off)", () => {
  it("groups by file with dim-dir/bold-basename header and aligned gutters", () => {
    const out = formatFindings(
      [
        finding({ loc: { file: "/repo/src/App.tsx", line: 9, col: 2 } }),
        finding({
          rule: "server-state-in-client-state",
          loc: { file: "/repo/src/App.tsx", line: 244, col: 0 },
        }),
      ],
      { color: false, cwd: "/repo" },
    );

    const lines = out.split("\n");
    expect(lines[0]).toBe("src/App.tsx");
    // Gutters right-align: '  9:2' pads to width of '244:0'.
    expect(out).toContain("    9:2  ▲ warn  prop-drilling");
    expect(out).toContain("  244:0  ▲ warn  server-state-in-client-state");
  });

  it("indents message and recommendation to a hanging block", () => {
    const out = formatFindings([finding()], { color: false, cwd: "/repo" });
    const lines = out.split("\n");
    expect(lines[1]).toBe("  12:4  ▲ warn  prop-drilling");
    expect(lines[2]).toBe("        Prop 'user' drills through 2 components.");
    expect(lines[3]).toBe("        → Move this state to Context or a store.");
  });

  it("soft-wraps long messages with hanging indent", () => {
    const out = formatFindings(
      [finding({ message: "word ".repeat(40).trim() })],
      { color: false, cwd: "/repo", width: 60 },
    );
    const wrapped = out
      .split("\n")
      .filter((l) => l.trimStart().startsWith("word"));
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped) {
      expect(line.length).toBeLessThanOrEqual(60);
      expect(line.startsWith("        ")).toBe(true);
    }
  });

  it("uses distinct glyphs per severity", () => {
    const out = formatFindings(
      [
        finding({ severity: "error" }),
        finding({ severity: "warn" }),
        finding({ severity: "info" }),
      ],
      { color: false, cwd: "/repo" },
    );
    expect(out).toContain("✖ error");
    expect(out).toContain("▲ warn");
    expect(out).toContain("ℹ info");
  });
});

describe("formatFindings — summary", () => {
  it("counts by severity and reports scan stats", () => {
    const out = formatFindings(
      [finding(), finding(), finding({ severity: "info" })],
      { color: false, cwd: "/repo", fileCount: 678, durationMs: 2400 },
    );
    expect(out).toContain("▲ 3 problems (2 warnings, 1 info)");
    expect(out).toContain("678 files scanned in 2.4s");
  });

  it("celebrates a clean run quietly", () => {
    const out = formatFindings([], {
      color: false,
      fileCount: 52,
      durationMs: 180,
    });
    expect(out).toContain("✓ no problems");
    expect(out).toContain("52 files scanned in 0.2s");
  });
});

describe("formatFindings — color", () => {
  it("emits ANSI codes when enabled and none when disabled", () => {
    const colored = formatFindings([finding()], { color: true, cwd: "/repo" });
    const plain = formatFindings([finding()], { color: false, cwd: "/repo" });
    expect(colored).toContain("\x1b[33m"); // warn = yellow
    expect(colored).toContain("\x1b[2m"); // dim metadata
    expect(plain).not.toContain("\x1b[");
  });
});

describe("exitCode", () => {
  it("fails CI on warnings, passes on info-only and clean", () => {
    expect(exitCode([finding()])).toBe(1);
    expect(exitCode([finding({ severity: "error" })])).toBe(1);
    expect(exitCode([finding({ severity: "info" })])).toBe(0);
    expect(exitCode([])).toBe(0);
  });
});
