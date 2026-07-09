/**
 * Vue SFC extraction — isolates the @vue/compiler-sfc dependency.
 * Returns the script block padded with newlines so every AST location maps
 * straight back to the .vue file, plus the raw template text for the
 * conservative can't-see-template guards in the Vue adapter.
 */

import { basename, dirname } from "node:path";
import { parse as parseSfc } from "@vue/compiler-sfc";
import type { TplNode } from "./vue-template.js";

export interface VueScript {
  /** Script content, newline-padded to preserve .vue line numbers. */
  code: string;
  /** True for `<script setup>`; false for a plain `<script>` block. */
  setup: boolean;
  /** Raw template source; null when the SFC has no template block. */
  template: string | null;
  /** Parsed template AST (locations are absolute in the .vue file). */
  templateAst: TplNode | null;
  /** 1-based line of the script block's opening tag. */
  scriptLine: number;
}

export function extractVueScript(path: string, code: string): VueScript | null {
  const { descriptor, errors } = parseSfc(code, { filename: path });
  if (errors.length > 0) throw errors[0];

  // <script setup> wins when both blocks exist — it's where state lives.
  const block = descriptor.scriptSetup ?? descriptor.script;
  if (!block) return null;

  return {
    code: "\n".repeat(Math.max(0, block.loc.start.line - 1)) + block.content,
    setup: block === descriptor.scriptSetup,
    template: descriptor.template?.content ?? null,
    templateAst: (descriptor.template?.ast as TplNode | undefined) ?? null,
    scriptLine: block.loc.start.line,
  };
}

/** Component identity is the file: TheHeader.vue → TheHeader; index.vue → its directory. */
export function vueComponentName(path: string): string {
  const base = basename(path, ".vue");
  if (base !== "index") return base;
  const dir = basename(dirname(path));
  return dir === "" || dir === "." ? "Index" : dir;
}
