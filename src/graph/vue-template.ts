/**
 * Vue template AST — minimal structural types over @vue/compiler-sfc's
 * parsed template (descriptor.template.ast), plus the expression helpers the
 * Vue adapter needs. Node `type` numbers are @vue/compiler-core's stable
 * public NodeTypes values; we type only the fields we touch.
 */

export interface TplLoc {
  start: { line: number; column: number };
}

export interface TplExpression {
  type: number;
  content: string;
  loc: TplLoc;
}

/** type 6 — static attribute (`class="wrap"`). Constant, never state. */
export interface TplAttr {
  type: 6;
  name: string;
  loc: TplLoc;
}

/** type 7 — directive (`:user="user"`, `v-model="q"`, `@click="n++"`). */
export interface TplDirective {
  type: 7;
  name: string; // 'bind' | 'model' | 'on' | 'if' | 'for' | …
  arg?: { content?: string } | null;
  exp?: TplExpression | null;
  loc: TplLoc;
}

/** type 1 — element; tagType 1 = component. */
export interface TplElement {
  type: 1;
  tag: string;
  tagType: number;
  props: Array<TplAttr | TplDirective>;
  children: TplNode[];
  loc: TplLoc;
}

/** type 5 — interpolation (`{{ expr }}`). */
export interface TplInterpolation {
  type: 5;
  content: TplExpression;
  loc: TplLoc;
}

export interface TplNode {
  type: number;
  children?: TplNode[];
  loc?: TplLoc;
}

export const TPL_ELEMENT = 1;
export const TPL_INTERPOLATION = 5;
export const TPL_ATTRIBUTE = 6;
export const TPL_DIRECTIVE = 7;
export const TAG_COMPONENT = 1;

export function walkTemplate(node: TplNode, visit: (n: TplNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkTemplate(child, visit);
}

/** Words that appear in template expressions but are never state bindings. */
const EXPRESSION_NOISE = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "in",
  "of",
  "typeof",
  "instanceof",
  "new",
  "this",
  "$event",
  "$emit",
  "$attrs",
  "$slots",
  "$refs",
  "$route",
  "$router",
  "$t",
]);

/**
 * Root identifiers referenced by a template expression string. Property
 * accesses (`item.name` → name) and object-literal keys (`{ compact: true }`
 * → compact) are excluded; misses bias toward silence.
 */
export function identifiersIn(exp: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z_$][\w$]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(exp)) !== null) {
    const name = match[0];
    if (EXPRESSION_NOISE.has(name)) continue;
    const before = exp.slice(0, match.index).replace(/\s+$/, "");
    if (before.endsWith(".") || before.endsWith("?.")) continue; // property access
    const after = exp.slice(match.index + name.length).replace(/^\s+/, "");
    // `key:` object keys — but not `a ? b : c` (the ternary arm has a space
    // before the colon in the sliced form only when the key form doesn't).
    if (after.startsWith(":") && !after.startsWith("::")) {
      // Distinguish `{ compact: true }` from `cond ? a : b`: a ternary arm is
      // preceded by `?` somewhere before this identifier at the same depth.
      // Cheap approximation: treat as key only right after `{` or `,`.
      if (before.endsWith("{") || before.endsWith(",")) continue;
    }
    out.add(name);
  }
  return out;
}

/** LHS binding names of a v-for expression: `(item, i) in items` → item, i. */
export function vForLocals(exp: string): Set<string> {
  const idx = exp.search(/\s+(?:in|of)\s+/);
  if (idx === -1) return new Set();
  const lhs = exp.slice(0, idx);
  return new Set([...lhs.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
}

/** Does this handler/model expression mutate `name`? (`x = …`, `x++`, `x--`) */
export function expressionMutates(exp: string, name: string): boolean {
  const id = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\w$.])${id}(?:\\.[\\w$]+)?\\s*(?:=[^=>]|\\+\\+|--)`,
  ).test(exp);
}

/** kebab-case → camelCase for prop names (`user-name` → `userName`). */
export function camelize(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** kebab-case or camelCase tag → PascalCase (`the-footer` → `TheFooter`). */
export function pascalize(tag: string): string {
  const camel = camelize(tag);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}
