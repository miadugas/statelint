/**
 * File discovery — shared by the CLI and the --ui server.
 * Architecture rules describe the app, not its tests, so test files are
 * skipped along with build output and vendor directories.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { SourceFileInput } from "./graph/build.js";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
  "__tests__",
  "__mocks__",
]);
const EXTENSIONS = new Set([".tsx", ".jsx", ".ts"]);
const TEST_FILE = /\.(test|spec)\.[jt]sx?$|\.stories\.[jt]sx?$/;

export function discoverFiles(root: string, out: SourceFileInput[]): void {
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
    } else if (
      EXTENSIONS.has(extname(entry.name)) &&
      !TEST_FILE.test(entry.name)
    ) {
      const path = join(root, entry.name);
      out.push({ path, code: readFileSync(path, "utf8") });
    }
  }
}
