/**
 * Graph builder — parses source files and populates the StateGraph.
 *
 * v1 scope: function components, useState/useReducer sources, and the
 * declares / reads / writes / passesProp edges. Context/Redux/Zustand/Query
 * adapters layer in later; each adds sources + edges, never new detector
 * logic (detectors only ever query the graph).
 */

import { dirname, join, normalize } from "node:path";
import { parse } from "@typescript-eslint/typescript-estree";
import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type {
  ComponentId,
  ComponentNode,
  Edge,
  MemoIssue,
  ReadVia,
  SourceLoc,
  StateClass,
  StateGraph,
  StateId,
  StateSource,
  WriteVia,
} from "./schema.js";
import { extractVueScript, vueComponentName } from "./vue-sfc.js";
import type {
  TplDirective,
  TplElement,
  TplInterpolation,
  TplNode,
} from "./vue-template.js";
import {
  TAG_COMPONENT,
  TPL_DIRECTIVE,
  TPL_ELEMENT,
  TPL_INTERPOLATION,
  camelize,
  expressionMutates,
  identifiersIn,
  pascalize,
  vForLocals,
  walkTemplate,
} from "./vue-template.js";

export interface SourceFileInput {
  path: string;
  code: string;
}

type FunctionLike =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

interface ComponentInfo {
  id: ComponentId;
  name: string;
  file: string;
  loc: SourceLoc;
  isMemo: boolean;
  fn: FunctionLike;
}

/** A raw `<Child foo={bar} />` observation, resolved to an edge in a later pass. */
interface PropPass {
  fromComponentId: ComponentId;
  fromFile: string;
  childName: string;
  prop: string;
  /** Value was an inline object/array/function literal — new ref every render. */
  inline: boolean;
  loc: SourceLoc;
}

/** What a local name refers to when imported: `{ source: './Layout', imported: 'default' }`. */
interface ImportRef {
  source: string;
  imported: string; // exported name, or 'default'
}

/** A `createContext(...)` declaration found in a file. */
interface ContextDecl {
  name: string;
  loc: SourceLoc;
}

/** A custom hook (`function useThing() {…}`) — an analysis unit like a component. */
interface HookInfo {
  id: string; // `${file}#${name}`
  name: string;
  file: string;
  fn: FunctionLike;
}

/** A zustand `create(...)` store declaration. */
interface StoreDecl {
  name: string;
  loc: SourceLoc;
  fields?: string[];
}

/** An RTK `createSlice(...)` declaration. Identity is the slice `name` property. */
interface SliceDecl {
  sliceName: string;
  loc: SourceLoc;
  fields?: string[];
}

/** A pinia `defineStore(...)` declaration. Identity is the store id string. */
interface PiniaStoreDecl {
  storeId: string;
  loc: SourceLoc;
  fields?: string[];
}

/** A Vuex `createStore({...})` / `new Vuex.Store({...})` — captured shallow at
 * collection time; root fields + module names are resolved later (module refs
 * may point cross-file, and records aren't all collected yet). */
interface VuexStoreDecl {
  /** The store config object literal, when it's an inline `{...}`. */
  config: TSESTree.ObjectExpression | null;
  loc: SourceLoc;
}

/** A Vue SFC — one component per file; the script AST is the analysis unit. */
interface VueComponentInfo {
  id: ComponentId;
  name: string;
  file: string;
  loc: SourceLoc;
  /** True for `<script setup>`; false for an Options API `<script>` block.
   * Branches script analysis (analyzeVueComponent vs analyzeVueOptionsComponent)
   * and the prop-read check (props.varName vs `this.propName`). */
  setup: boolean;
  program: TSESTree.Program;
  /** Raw template text — mutation-guard fallback when the AST is unavailable. */
  template: string | null;
  /** Parsed template AST — drives prop passes, template reads, and precise
   * mutation detection. */
  templateAst: TplNode | null;
  /** defineProps declaration — needed for drill chains and prop-read checks. */
  props: VuePropsInfo;
}

interface VuePropsInfo {
  /** Declared prop names, camelCase. */
  names: Set<string>;
  /** `const props = defineProps(...)` binding, if any. */
  varName: string | null;
  /** `const { user } = defineProps(...)` destructured names. */
  destructured: Set<string>;
}

/** A raw `:prop="expr"` observation on a component tag, resolved later. */
interface VuePropPass {
  fromComponentId: ComponentId;
  fromFile: string;
  childTag: string;
  prop: string;
  /** Inline object/array/function literal — new reference every render. */
  inline: boolean;
  loc: SourceLoc;
}

/** Everything statelinter knows about one parsed file. */
interface FileRecord {
  path: string;
  /** The parsed program AST — retained so mixin/Vuex-module object literals can
   * be resolved across files. */
  program: TSESTree.Program;
  components: Map<string, ComponentInfo>;
  contexts: Map<string, ContextDecl>;
  stores: Map<string, StoreDecl>;
  slices: SliceDecl[];
  rtkQueryEndpoints: Map<string, SourceLoc>; // endpoint name → declaration site
  piniaStores: Map<string, PiniaStoreDecl>; // local hook name → store decl
  vuexStores: VuexStoreDecl[]; // createStore/new Vuex.Store declarations
  vueComponent: VueComponentInfo | null; // set when the file is an SFC
  nuxtMarkerCalls: Set<string>; // Nuxt composable names seen called in this file
  hooks: Map<string, HookInfo>;
  imports: Map<string, ImportRef>; // local name → where it came from
  exports: Map<string, string>; // exported name ('default' allowed) → local symbol name
}

type ParentMap = WeakMap<TSESTree.Node, TSESTree.Node>;

// ─── AST utilities ───

function isNode(value: unknown): value is TSESTree.Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function walk(
  node: TSESTree.Node,
  visit: (n: TSESTree.Node) => void,
  parents?: ParentMap,
): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!isNode(child)) continue;
      parents?.set(child, node);
      walk(child, visit, parents);
    }
  }
}

function toLoc(file: string, node: TSESTree.Node): SourceLoc {
  return { file, line: node.loc.start.line, col: node.loc.start.column };
}

function isCapitalized(name: string): boolean {
  const first = name[0];
  return (
    first !== undefined &&
    first === first.toUpperCase() &&
    first !== first.toLowerCase()
  );
}

function asFunction(
  node: TSESTree.Node | null | undefined,
): FunctionLike | null {
  if (!node) return null;
  if (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  )
    return node;
  return null;
}

/** `memo(fn)` or `React.memo(fn)` — returns the wrapped function. */
function unwrapMemo(node: TSESTree.Node): FunctionLike | null {
  if (node.type !== "CallExpression") return null;
  const callee = node.callee;
  const isMemoName =
    (callee.type === "Identifier" && callee.name === "memo") ||
    (callee.type === "MemberExpression" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "React" &&
      callee.property.type === "Identifier" &&
      callee.property.name === "memo");
  if (!isMemoName) return null;
  return asFunction(node.arguments[0]);
}

/** True when an Identifier occupies a non-expression position (binding, key, etc.). */
function isNonValuePosition(
  node: TSESTree.Node,
  parent: TSESTree.Node | undefined,
): boolean {
  if (!parent) return true;
  if (parent.type === "ArrayPattern" || parent.type === "ObjectPattern")
    return true;
  if (parent.type === "Property" && parent.key === node && !parent.computed)
    return true;
  if (
    parent.type === "MemberExpression" &&
    parent.property === node &&
    !parent.computed
  )
    return true;
  if (parent.type === "VariableDeclarator" && parent.id === node) return true;
  if (
    parent.type === "ImportSpecifier" ||
    parent.type === "ImportDefaultSpecifier"
  )
    return true;
  return false;
}

/** Is this expression node the direct value of a JSX attribute on a *component* element? */
function isForwardToComponent(
  node: TSESTree.Node,
  parents: ParentMap,
): boolean {
  const container = parents.get(node);
  if (container?.type !== "JSXExpressionContainer") return false;
  const attr = parents.get(container);
  if (attr?.type !== "JSXAttribute") return false;
  const opening = parents.get(attr);
  if (opening?.type !== "JSXOpeningElement") return false;
  return (
    opening.name.type === "JSXIdentifier" && isCapitalized(opening.name.name)
  );
}

// ─── File collection: components + imports + exports ───

function collectFileRecord(ast: TSESTree.Program, file: string): FileRecord {
  const record: FileRecord = {
    path: file,
    program: ast,
    components: new Map(),
    contexts: new Map(),
    stores: new Map(),
    slices: [],
    rtkQueryEndpoints: new Map(),
    piniaStores: new Map(),
    vuexStores: [],
    vueComponent: null,
    nuxtMarkerCalls: new Set(),
    hooks: new Map(),
    imports: new Map(),
    exports: new Map(),
  };

  const addHook = (name: string, fn: FunctionLike) => {
    record.hooks.set(name, { id: `${file}#${name}`, name, file, fn });
  };

  const addComponent = (
    name: string,
    fn: FunctionLike,
    node: TSESTree.Node,
    isMemo: boolean,
  ) => {
    record.components.set(name, {
      id: `${file}#${name}`,
      name,
      file,
      loc: toLoc(file, node),
      isMemo,
      fn,
    });
  };

  walk(ast, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      NUXT_MARKERS.has(node.callee.name)
    ) {
      record.nuxtMarkerCalls.add(node.callee.name);
      return;
    }

    // `createStore({...})` from vuex — the store config; fields/modules are
    // resolved later when the full record set is available.
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "createStore" &&
      importedFrom(record, "createStore", "vuex")
    ) {
      const cfg = node.arguments[0];
      record.vuexStores.push({
        config: cfg?.type === "ObjectExpression" ? cfg : null,
        loc: toLoc(file, node),
      });
      return;
    }

    // `new Vuex.Store({...})` — legacy Vuex 3 form, default import named Vuex.
    if (
      node.type === "NewExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "Store" &&
      record.imports.get(node.callee.object.name)?.source === "vuex"
    ) {
      const cfg = node.arguments[0];
      record.vuexStores.push({
        config: cfg?.type === "ObjectExpression" ? cfg : null,
        loc: toLoc(file, node),
      });
      return;
    }

    if (node.type === "FunctionDeclaration" && node.id) {
      if (isCapitalized(node.id.name)) {
        addComponent(node.id.name, node, node, false);
      } else if (isHookName(node.id.name)) {
        addHook(node.id.name, node);
      }
      return;
    }

    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      const name = node.id.name;
      if (!node.init) return;
      if (isCreateContextCall(node.init)) {
        record.contexts.set(name, { name, loc: toLoc(file, node) });
        return;
      }
      const storeInit = zustandCreateInitializer(node.init, record);
      if (storeInit !== null) {
        record.stores.set(name, {
          name,
          loc: toLoc(file, node),
          fields: storeInit.fields,
        });
        return;
      }
      const slice = rtkSliceDecl(node.init, name, toLoc(file, node), record);
      if (slice) {
        record.slices.push(slice);
        return;
      }
      if (collectRtkApiEndpoints(node.init, toLoc(file, node), record)) return;
      const pinia = piniaStoreDecl(node.init, name, record);
      if (pinia) {
        record.piniaStores.set(name, { ...pinia, loc: toLoc(file, node) });
        return;
      }
      const direct = asFunction(node.init);
      if (isHookName(name)) {
        if (direct) addHook(name, direct);
        return;
      }
      if (!isCapitalized(name)) return;
      const memoized = direct ? null : unwrapMemo(node.init);
      const fn = direct ?? memoized;
      if (fn) addComponent(name, fn, node, memoized !== null);
      return;
    }

    if (node.type === "ImportDeclaration") {
      const source = node.source.value;
      for (const spec of node.specifiers) {
        if (spec.type === "ImportDefaultSpecifier") {
          record.imports.set(spec.local.name, { source, imported: "default" });
        } else if (
          spec.type === "ImportSpecifier" &&
          spec.imported.type === "Identifier"
        ) {
          record.imports.set(spec.local.name, {
            source,
            imported: spec.imported.name,
          });
        }
      }
      return;
    }

    if (node.type === "ExportNamedDeclaration") {
      const decl = node.declaration;
      if (decl?.type === "FunctionDeclaration" && decl.id) {
        record.exports.set(decl.id.name, decl.id.name);
      } else if (decl?.type === "VariableDeclaration") {
        for (const d of decl.declarations) {
          if (d.id.type === "Identifier")
            record.exports.set(d.id.name, d.id.name);
        }
      }
      for (const spec of node.specifiers) {
        if (
          spec.type === "ExportSpecifier" &&
          spec.local.type === "Identifier" &&
          spec.exported.type === "Identifier"
        ) {
          record.exports.set(spec.exported.name, spec.local.name);
        }
      }
      return;
    }

    if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      if (decl.type === "FunctionDeclaration" && decl.id) {
        record.exports.set("default", decl.id.name);
      } else if (decl.type === "Identifier") {
        record.exports.set("default", decl.name);
      }
    }
  });

  return record;
}

// ─── Cross-file resolution ───

const RESOLVE_SUFFIXES = [
  "",
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".vue",
  "/index.tsx",
  "/index.ts",
  "/index.jsx",
  "/index.js",
  "/index.vue",
];

/** Resolve a relative import specifier against the analyzed file set. */
function resolveModule(
  fromPath: string,
  specifier: string,
  records: Map<string, FileRecord>,
): FileRecord | null {
  if (!specifier.startsWith(".")) return null; // package imports — out of scope
  const base = normalize(join(dirname(fromPath), specifier));
  for (const suffix of RESOLVE_SUFFIXES) {
    const record = records.get(base + suffix);
    if (record) return record;
  }
  return null;
}

/** Resolve a JSX element name in a file to its component — local first, then imports. */
function resolveComponent(
  from: FileRecord,
  name: string,
  records: Map<string, FileRecord>,
): ComponentInfo | null {
  const local = from.components.get(name);
  if (local) return local;

  const importRef = from.imports.get(name);
  if (!importRef) return null;
  const target = resolveModule(from.path, importRef.source, records);
  if (!target) return null;

  const localName = target.exports.get(importRef.imported);
  if (!localName) return null;
  return target.components.get(localName) ?? null;
}

/** A top-level `const name = {…}` (or `export const name = {…}`) in a program. */
function findObjectConst(
  program: TSESTree.Program,
  name: string,
): TSESTree.ObjectExpression | null {
  for (const stmt of program.body) {
    const decl =
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (decl?.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      if (
        d.id.type === "Identifier" &&
        d.id.name === name &&
        d.init?.type === "ObjectExpression"
      )
        return d.init;
    }
  }
  return null;
}

/** The `export default {…}` object of a program — direct literal, or an
 * identifier pointing at a top-level object const. */
function findDefaultExportObject(
  program: TSESTree.Program,
): TSESTree.ObjectExpression | null {
  for (const stmt of program.body) {
    if (stmt.type !== "ExportDefaultDeclaration") continue;
    const decl = stmt.declaration;
    if (decl.type === "ObjectExpression") return decl;
    if (decl.type === "Identifier") return findObjectConst(program, decl.name);
  }
  return null;
}

/**
 * Resolve an identifier to the object literal it names — a local `const`, an
 * imported default `{…}` export, or a named `export const`. Used for mixins and
 * Vuex module registrations, both of which reference plain option objects.
 */
function resolveObjectExpression(
  from: FileRecord,
  name: string,
  records: Map<string, FileRecord>,
): TSESTree.ObjectExpression | null {
  const local = findObjectConst(from.program, name);
  if (local) return local;

  const importRef = from.imports.get(name);
  if (!importRef) return null;
  const target = resolveModule(from.path, importRef.source, records);
  if (!target) return null;
  if (importRef.imported === "default")
    return findDefaultExportObject(target.program);
  const localName =
    target.exports.get(importRef.imported) ?? importRef.imported;
  return findObjectConst(target.program, localName);
}

// ─── Context adapter ───

/** `createContext(...)` or `React.createContext(...)`. */
function isCreateContextCall(node: TSESTree.Node): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  return (
    (callee.type === "Identifier" && callee.name === "createContext") ||
    (callee.type === "MemberExpression" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "React" &&
      callee.property.type === "Identifier" &&
      callee.property.name === "createContext")
  );
}

/** Resolve a context name in a file to its StateId — local first, then imports. */
function resolveContext(
  from: FileRecord,
  name: string,
  records: Map<string, FileRecord>,
): StateId | null {
  if (from.contexts.has(name)) return `${from.path}#${name}`;

  const importRef = from.imports.get(name);
  if (!importRef) return null;
  const target = resolveModule(from.path, importRef.source, records);
  if (!target) return null;

  const localName = target.exports.get(importRef.imported);
  if (!localName || !target.contexts.has(localName)) return null;
  return `${target.path}#${localName}`;
}

/** `useThing`, `useLock`, … — the custom-hook naming convention. */
function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

/** Resolve a hook name in a file to its HookInfo — local first, then imports. */
function resolveHook(
  from: FileRecord,
  name: string,
  records: Map<string, FileRecord>,
): HookInfo | null {
  const local = from.hooks.get(name);
  if (local) return local;

  const importRef = from.imports.get(name);
  if (!importRef) return null;
  const target = resolveModule(from.path, importRef.source, records);
  if (!target) return null;

  const localName = target.exports.get(importRef.imported);
  if (!localName) return null;
  return target.hooks.get(localName) ?? null;
}

// ─── TanStack Query adapter ───

const QUERY_HOOKS = new Set([
  "useQuery",
  "useInfiniteQuery",
  "useSuspenseQuery",
]);

/** Is `name` one of the query hooks, imported from TanStack (or legacy react-query)? */
function isQueryHook(name: string, from: FileRecord): boolean {
  if (!QUERY_HOOKS.has(name)) return false;
  const source = from.imports.get(name)?.source;
  return (
    source !== undefined &&
    (source.startsWith("@tanstack/") || source === "react-query")
  );
}

/**
 * Extract the string query key: `useQuery({ queryKey: ['todos'] })` (v5) or
 * `useQuery(['todos'], fn)` (v4). Dynamic keys return null — an unknown key
 * gets no source rather than a garbage one.
 */
function queryKeyOf(call: TSESTree.CallExpression): string | null {
  const arg = call.arguments[0];
  if (!arg) return null;

  let keyArray: TSESTree.Node | undefined;
  if (arg.type === "ArrayExpression") {
    keyArray = arg;
  } else if (arg.type === "ObjectExpression") {
    for (const prop of arg.properties) {
      if (
        prop.type === "Property" &&
        prop.key.type === "Identifier" &&
        prop.key.name === "queryKey"
      ) {
        keyArray = prop.value;
        break;
      }
    }
  }
  if (keyArray?.type !== "ArrayExpression") return null;

  const first = keyArray.elements[0];
  if (first?.type === "Literal" && typeof first.value === "string")
    return first.value;
  return null;
}

/** StateId for a query — keyed by the query key, NOT the call site: the cache is global. */
function queryStateId(key: string): StateId {
  return `query:${key}`;
}

// ─── Web Storage adapter ───

const STORAGE_METHODS = new Set(["getItem", "setItem", "removeItem"]);

/** StateId for a storage key — the key IS the identity, like query keys. */
function storageStateId(area: "local" | "session", key: string): StateId {
  return `storage:${area}:${key}`;
}

/**
 * Matches `localStorage.getItem('k')` / `sessionStorage.setItem('k', v)` /
 * `window.localStorage.…`. Dynamic keys are skipped — an unknown key gets
 * no source rather than a garbage one.
 */
function storageAccessOf(
  node: TSESTree.CallExpression,
): { id: StateId; access: "read" | "write" } | null {
  if (node.callee.type !== "MemberExpression") return null;
  const { object, property } = node.callee;
  if (property.type !== "Identifier" || !STORAGE_METHODS.has(property.name))
    return null;

  let storageName: string | null = null;
  if (object.type === "Identifier") storageName = object.name;
  else if (
    object.type === "MemberExpression" &&
    object.property.type === "Identifier" &&
    object.object.type === "Identifier" &&
    (object.object.name === "window" || object.object.name === "globalThis")
  ) {
    storageName = object.property.name;
  }
  const area =
    storageName === "localStorage"
      ? "local"
      : storageName === "sessionStorage"
        ? "session"
        : null;
  if (!area) return null;

  const keyArg = node.arguments[0];
  if (keyArg?.type !== "Literal" || typeof keyArg.value !== "string")
    return null;

  return {
    id: storageStateId(area, keyArg.value),
    access: property.name === "getItem" ? "read" : "write",
  };
}

// ─── URL state adapter ───

const SEARCH_PARAM_SOURCES = ["react-router", "next/navigation"];
const PARAMS_HOOK_SOURCES = ["react-router", "next/navigation"];

/** StateId for a URL param — the param name is the identity (the address bar is global). */
function urlStateId(key: string): StateId {
  return `url:${key}`;
}

function importedFromAny(
  record: FileRecord,
  name: string,
  prefixes: string[],
): boolean {
  const source = record.imports.get(name)?.source;
  return source !== undefined && prefixes.some((p) => source.startsWith(p));
}

interface UrlBindings {
  /** Local names bound to the searchParams object (`const [sp, setSp] = useSearchParams()`). */
  params: Set<string>;
  /** Local names bound to the setter. */
  setters: Set<string>;
}

/** Pre-pass: find searchParams/setter bindings and useParams destructures. */
function collectUrlBindings(
  fn: TSESTree.Node,
  from: FileRecord,
  use: SharedUse,
  urlLocs: Map<StateId, SourceLoc>,
): UrlBindings {
  const bindings: UrlBindings = { params: new Set(), setters: new Set() };
  walk(fn, (node) => {
    if (node.type !== "VariableDeclarator") return;
    if (node.init?.type !== "CallExpression") return;
    const callee = node.init.callee;
    if (callee.type !== "Identifier") return;

    if (
      callee.name === "useSearchParams" &&
      importedFromAny(from, "useSearchParams", SEARCH_PARAM_SOURCES)
    ) {
      if (node.id.type === "ArrayPattern") {
        const [sp, setSp] = node.id.elements;
        if (sp?.type === "Identifier") bindings.params.add(sp.name);
        if (setSp?.type === "Identifier") bindings.setters.add(setSp.name);
      } else if (node.id.type === "Identifier") {
        bindings.params.add(node.id.name); // Next.js: read-only object
      }
      return;
    }

    if (
      callee.name === "useParams" &&
      importedFromAny(from, "useParams", PARAMS_HOOK_SOURCES) &&
      node.id.type === "ObjectPattern"
    ) {
      for (const prop of node.id.properties) {
        if (prop.type === "Property" && prop.key.type === "Identifier") {
          const id = urlStateId(prop.key.name);
          use.urlReads.add(id);
          if (!urlLocs.has(id)) urlLocs.set(id, toLoc(from.path, node));
        }
      }
    }
  });
  return bindings;
}

/** `sp.get('tab')` on a known searchParams binding → the url key read. */
function urlReadKeyOf(
  node: TSESTree.CallExpression,
  bindings: UrlBindings,
): string | null {
  if (node.callee.type !== "MemberExpression") return null;
  const { object, property } = node.callee;
  if (object.type !== "Identifier" || !bindings.params.has(object.name))
    return null;
  if (property.type !== "Identifier" || property.name !== "get") return null;
  const arg = node.arguments[0];
  if (arg?.type !== "Literal" || typeof arg.value !== "string") return null;
  return arg.value;
}

// ─── Cookie adapter ───

/** StateId for a cookie — the cookie name is the identity. */
function cookieStateId(name: string): StateId {
  return `cookie:${name}`;
}

interface CookieBindings {
  /** `const [cookies, setCookie] = useCookies([...])` — reactive (context-backed). */
  jarNames: Set<string>;
  setterNames: Set<string>;
  removerNames: Set<string>;
  /** Default-import name for js-cookie (`import Cookies from 'js-cookie'`) — NOT reactive. */
  jsCookieName: string | null;
}

/** Pre-pass: react-cookie bindings (declared keys count as reads) + js-cookie import. */
function collectCookieBindings(
  fn: TSESTree.Node,
  from: FileRecord,
  use: SharedUse,
  cookieLocs: Map<StateId, SourceLoc>,
): CookieBindings {
  const bindings: CookieBindings = {
    jarNames: new Set(),
    setterNames: new Set(),
    removerNames: new Set(),
    jsCookieName: null,
  };
  for (const [local, ref] of from.imports) {
    if (ref.source === "js-cookie" && ref.imported === "default")
      bindings.jsCookieName = local;
  }

  walk(fn, (node) => {
    if (node.type !== "VariableDeclarator") return;
    if (node.init?.type !== "CallExpression") return;
    const callee = node.init.callee;
    if (callee.type !== "Identifier" || callee.name !== "useCookies") return;
    if (!importedFromAny(from, "useCookies", ["react-cookie"])) return;

    if (node.id.type === "ArrayPattern") {
      const [jar, setter, remover] = node.id.elements;
      if (jar?.type === "Identifier") bindings.jarNames.add(jar.name);
      if (setter?.type === "Identifier") bindings.setterNames.add(setter.name);
      if (remover?.type === "Identifier")
        bindings.removerNames.add(remover.name);
    }
    // useCookies(['token']) — the dependency list is a subscription: a read.
    const arg = node.init.arguments[0];
    if (arg?.type === "ArrayExpression") {
      for (const el of arg.elements) {
        if (el?.type === "Literal" && typeof el.value === "string") {
          const id = cookieStateId(el.value);
          use.cookieReadsReactive.add(id);
          if (!cookieLocs.has(id)) cookieLocs.set(id, toLoc(from.path, node));
        }
      }
    }
  });
  return bindings;
}

/** `document.cookie = "theme=dark; path=/"` → 'theme'. Dynamic strings are skipped. */
function cookieNameFromAssignment(right: TSESTree.Node): string | null {
  let text: string | null = null;
  if (right.type === "Literal" && typeof right.value === "string")
    text = right.value;
  else if (right.type === "TemplateLiteral" && right.quasis[0])
    text = right.quasis[0].value.cooked ?? null;
  if (!text) return null;
  const match = /^([^=;\s]+)=/.exec(text);
  return match?.[1] ?? null;
}

// ─── Shared-state usage (contexts, queries, storage, URL, cookies — direct or through hooks) ───

/** What a function body touches: contexts, query keys, storage keys, URL params, cookies, hooks. */
interface SharedUse {
  ctxIds: Set<StateId>;
  queryKeys: Set<string>;
  storageReads: Set<StateId>;
  storageWrites: Set<StateId>;
  urlReads: Set<StateId>;
  urlWrites: Set<StateId>;
  /** useState vars initialized FROM a url read: the fork pattern. */
  urlForks: Array<{ stateName: string; urlId: StateId }>;
  /** Reactive access (react-cookie) vs raw (js-cookie / document.cookie) — the
   * distinction matters: raw writes never notify reactive readers. */
  cookieReadsReactive: Set<StateId>;
  cookieReadsRaw: Set<StateId>;
  cookieWritesReactive: Set<StateId>;
  cookieWritesRaw: Set<StateId>;
  /** Pinia stores read via their use*Store hook (Vue components + composables). */
  piniaReads: Set<StateId>;
  hookIds: Set<string>;
}

function scanSharedUse(
  fn: TSESTree.Node,
  from: FileRecord,
  records: Map<string, FileRecord>,
  queryLocs: Map<string, SourceLoc>,
  storageLocs: Map<StateId, SourceLoc>,
  urlLocs: Map<StateId, SourceLoc>,
  cookieLocs: Map<StateId, SourceLoc>,
): SharedUse {
  const use: SharedUse = {
    ctxIds: new Set(),
    queryKeys: new Set(),
    storageReads: new Set(),
    storageWrites: new Set(),
    urlReads: new Set(),
    urlWrites: new Set(),
    urlForks: [],
    cookieReadsReactive: new Set(),
    cookieReadsRaw: new Set(),
    cookieWritesReactive: new Set(),
    cookieWritesRaw: new Set(),
    piniaReads: new Set(),
    hookIds: new Set(),
  };
  const urlBindings = collectUrlBindings(fn, from, use, urlLocs);
  const cookieBindings = collectCookieBindings(fn, from, use, cookieLocs);

  const markCookie = (
    name: string,
    bucket: Set<StateId>,
    node: TSESTree.Node,
  ) => {
    const id = cookieStateId(name);
    bucket.add(id);
    if (!cookieLocs.has(id)) cookieLocs.set(id, toLoc(from.path, node));
  };

  const markUrlRead = (key: string, node: TSESTree.Node) => {
    const id = urlStateId(key);
    use.urlReads.add(id);
    if (!urlLocs.has(id)) urlLocs.set(id, toLoc(from.path, node));
    return id;
  };

  walk(fn, (node) => {
    // Fork pattern: const [tab, setTab] = useState(sp.get('tab') ?? …)
    if (
      node.type === "VariableDeclarator" &&
      node.init?.type === "CallExpression" &&
      node.init.callee.type === "Identifier" &&
      node.init.callee.name === "useState" &&
      node.id.type === "ArrayPattern" &&
      node.id.elements[0]?.type === "Identifier"
    ) {
      const stateName = node.id.elements[0].name;
      const initArg = node.init.arguments[0];
      if (initArg) {
        walk(initArg, (inner) => {
          if (inner.type !== "CallExpression") return;
          const key = urlReadKeyOf(inner, urlBindings);
          if (key) use.urlForks.push({ stateName, urlId: urlStateId(key) });
        });
      }
      return;
    }

    // document.cookie = "theme=dark; path=/" — raw, non-reactive write
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression" &&
      node.left.object.type === "Identifier" &&
      node.left.object.name === "document" &&
      node.left.property.type === "Identifier" &&
      node.left.property.name === "cookie"
    ) {
      const name = cookieNameFromAssignment(node.right);
      if (name) markCookie(name, use.cookieWritesRaw, node);
      return;
    }

    // cookies.token on a react-cookie jar — reactive read
    if (
      node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      cookieBindings.jarNames.has(node.object.name) &&
      node.property.type === "Identifier" &&
      !node.computed
    ) {
      markCookie(node.property.name, use.cookieReadsReactive, node);
      return;
    }

    if (node.type !== "CallExpression") return;

    const storage = storageAccessOf(node);
    if (storage) {
      if (storage.access === "read") use.storageReads.add(storage.id);
      else use.storageWrites.add(storage.id);
      if (!storageLocs.has(storage.id))
        storageLocs.set(storage.id, toLoc(from.path, node));
      return;
    }

    // Cookies.get('token') / Cookies.set('token', v) — js-cookie, non-reactive
    if (
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === cookieBindings.jsCookieName &&
      node.callee.property.type === "Identifier"
    ) {
      const method = node.callee.property.name;
      const arg = node.arguments[0];
      if (
        (method === "get" || method === "set" || method === "remove") &&
        arg?.type === "Literal" &&
        typeof arg.value === "string"
      ) {
        markCookie(
          arg.value,
          method === "get" ? use.cookieReadsRaw : use.cookieWritesRaw,
          node,
        );
        return;
      }
    }

    // sp.get('tab') on a searchParams binding
    const urlKey = urlReadKeyOf(node, urlBindings);
    if (urlKey) {
      markUrlRead(urlKey, node);
      return;
    }

    if (node.callee.type !== "Identifier") return;
    const calleeName = node.callee.name;

    // setCookie('token', v) / removeCookie('token') — react-cookie, reactive
    if (
      cookieBindings.setterNames.has(calleeName) ||
      cookieBindings.removerNames.has(calleeName)
    ) {
      const arg = node.arguments[0];
      if (arg?.type === "Literal" && typeof arg.value === "string") {
        markCookie(arg.value, use.cookieWritesReactive, node);
      }
      return;
    }

    // setSearchParams({ page: … }) — object-literal keys are writes
    if (urlBindings.setters.has(calleeName)) {
      const arg = node.arguments[0];
      if (arg?.type === "ObjectExpression") {
        for (const prop of arg.properties) {
          if (prop.type === "Property" && prop.key.type === "Identifier") {
            const id = urlStateId(prop.key.name);
            use.urlWrites.add(id);
            if (!urlLocs.has(id)) urlLocs.set(id, toLoc(from.path, node));
          }
        }
      }
      return;
    }

    // nuqs: useQueryState('tab') is a read+write binding to url:tab
    if (
      calleeName === "useQueryState" &&
      importedFromAny(from, "useQueryState", ["nuqs"])
    ) {
      const arg = node.arguments[0];
      if (arg?.type === "Literal" && typeof arg.value === "string") {
        const id = markUrlRead(arg.value, node);
        use.urlWrites.add(id);
      }
      return;
    }

    if (calleeName === "useContext" || calleeName === "use") {
      const arg = node.arguments[0];
      if (arg?.type !== "Identifier") return;
      const ctxId = resolveContext(from, arg.name, records);
      if (ctxId) use.ctxIds.add(ctxId);
      return;
    }
    if (isQueryHook(calleeName, from)) {
      const key = queryKeyOf(node);
      if (key) {
        use.queryKeys.add(key);
        if (!queryLocs.has(key)) queryLocs.set(key, toLoc(from.path, node));
      }
      return;
    }
    if (isHookName(calleeName)) {
      const piniaId = resolvePiniaStore(from, calleeName, records);
      if (piniaId) {
        use.piniaReads.add(piniaId);
        return;
      }
      const hook = resolveHook(from, calleeName, records);
      if (hook) use.hookIds.add(hook.id);
    }
  });
  return use;
}

/**
 * What each custom hook consumes — contexts and queries — including through
 * other hooks (useTodos → useQuery(['todos'])). Fixpoint over hook→hook calls.
 */
function computeHookSharedUse(
  records: Map<string, FileRecord>,
  queryLocs: Map<string, SourceLoc>,
  storageLocs: Map<StateId, SourceLoc>,
  urlLocs: Map<StateId, SourceLoc>,
  cookieLocs: Map<StateId, SourceLoc>,
): Map<string, SharedUse> {
  const uses = new Map<string, SharedUse>();
  for (const record of records.values()) {
    for (const hook of record.hooks.values()) {
      uses.set(
        hook.id,
        scanSharedUse(
          hook.fn,
          record,
          records,
          queryLocs,
          storageLocs,
          urlLocs,
          cookieLocs,
        ),
      );
    }
  }

  const spread = (from: Set<string>, into: Set<string>): boolean => {
    let grew = false;
    for (const item of from) {
      if (!into.has(item)) {
        into.add(item);
        grew = true;
      }
    }
    return grew;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const use of uses.values()) {
      for (const calleeId of use.hookIds) {
        const callee = uses.get(calleeId);
        if (!callee) continue;
        if (spread(callee.ctxIds, use.ctxIds)) changed = true;
        if (spread(callee.queryKeys, use.queryKeys)) changed = true;
        if (spread(callee.storageReads, use.storageReads)) changed = true;
        if (spread(callee.storageWrites, use.storageWrites)) changed = true;
        if (spread(callee.urlReads, use.urlReads)) changed = true;
        if (spread(callee.urlWrites, use.urlWrites)) changed = true;
        if (spread(callee.cookieReadsReactive, use.cookieReadsReactive))
          changed = true;
        if (spread(callee.cookieReadsRaw, use.cookieReadsRaw)) changed = true;
        if (spread(callee.cookieWritesReactive, use.cookieWritesReactive))
          changed = true;
        if (spread(callee.cookieWritesRaw, use.cookieWritesRaw)) changed = true;
        if (spread(callee.piniaReads, use.piniaReads)) changed = true;
      }
    }
  }
  return uses;
}

/** Emit consumes/reads/provides edges for a component's shared-state usage.
 * The unit is any analyzable body: a React component fn or a Vue SFC program. */
function analyzeSharedStateUsage(
  comp: { id: ComponentId; name: string; file: string; fn: TSESTree.Node },
  from: FileRecord,
  records: Map<string, FileRecord>,
  hookUse: Map<string, SharedUse>,
  queryLocs: Map<string, SourceLoc>,
  storageLocs: Map<StateId, SourceLoc>,
  urlLocs: Map<StateId, SourceLoc>,
  cookieLocs: Map<StateId, SourceLoc>,
  edges: Edge[],
): void {
  const seen = new Set<string>();
  const push = (edge: Edge, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  const use = scanSharedUse(
    comp.fn,
    from,
    records,
    queryLocs,
    storageLocs,
    urlLocs,
    cookieLocs,
  );
  for (const hookId of use.hookIds) {
    const consumed = hookUse.get(hookId);
    if (!consumed) continue;
    for (const ctxId of consumed.ctxIds) use.ctxIds.add(ctxId);
    for (const key of consumed.queryKeys) use.queryKeys.add(key);
    for (const id of consumed.storageReads) use.storageReads.add(id);
    for (const id of consumed.storageWrites) use.storageWrites.add(id);
    for (const id of consumed.urlReads) use.urlReads.add(id);
    for (const id of consumed.urlWrites) use.urlWrites.add(id);
    for (const id of consumed.cookieReadsReactive)
      use.cookieReadsReactive.add(id);
    for (const id of consumed.cookieReadsRaw) use.cookieReadsRaw.add(id);
    for (const id of consumed.cookieWritesReactive)
      use.cookieWritesReactive.add(id);
    for (const id of consumed.cookieWritesRaw) use.cookieWritesRaw.add(id);
    for (const id of consumed.piniaReads) use.piniaReads.add(id);
  }
  for (const id of use.piniaReads) {
    push({ type: "reads", from: comp.id, to: id, via: "hook" }, `reads|${id}`);
  }
  for (const ctxId of use.ctxIds) {
    push(
      { type: "consumes", from: comp.id, to: ctxId, via: "context" },
      `consumes|${ctxId}`,
    );
  }
  for (const key of use.queryKeys) {
    const queryId = queryStateId(key);
    push(
      { type: "reads", from: comp.id, to: queryId, via: "hook" },
      `reads|${queryId}`,
    );
  }
  for (const id of use.storageReads) {
    push({ type: "reads", from: comp.id, to: id, via: "hook" }, `reads|${id}`);
  }
  for (const id of use.storageWrites) {
    push(
      { type: "writes", from: comp.id, to: id, via: "mutate" },
      `writes|${id}`,
    );
  }
  for (const id of use.urlReads) {
    push({ type: "reads", from: comp.id, to: id, via: "hook" }, `reads|${id}`);
  }
  for (const id of use.urlWrites) {
    push(
      { type: "writes", from: comp.id, to: id, via: "mutate" },
      `writes|${id}`,
    );
  }
  // Cookie edges carry the reactivity distinction in `via`: context/setter =
  // react-cookie (reactive), hook/mutate = js-cookie or document.cookie (raw).
  for (const id of use.cookieReadsReactive) {
    push(
      { type: "reads", from: comp.id, to: id, via: "context" },
      `reads|${id}|context`,
    );
  }
  for (const id of use.cookieReadsRaw) {
    push(
      { type: "reads", from: comp.id, to: id, via: "hook" },
      `reads|${id}|hook`,
    );
  }
  for (const id of use.cookieWritesReactive) {
    push(
      { type: "writes", from: comp.id, to: id, via: "setter" },
      `writes|${id}|setter`,
    );
  }
  for (const id of use.cookieWritesRaw) {
    push(
      { type: "writes", from: comp.id, to: id, via: "mutate" },
      `writes|${id}|mutate`,
    );
  }
  // The fork pattern becomes a derivesFrom edge: useState var ← url param.
  for (const fork of use.urlForks) {
    const stateId: StateId = `${comp.file}#${comp.name}.${fork.stateName}`;
    push(
      { type: "derivesFrom", from: stateId, to: fork.urlId },
      `derivesFrom|${stateId}|${fork.urlId}`,
    );
  }

  // Inspect a provider element's `value={...}` attribute: is it an inline
  // object/array/function literal (a new reference every render), and where?
  const providerValue = (
    node: TSESTree.JSXOpeningElement,
  ): { inline: boolean; loc?: SourceLoc } => {
    for (const attr of node.attributes) {
      if (
        attr.type === "JSXAttribute" &&
        attr.name.type === "JSXIdentifier" &&
        attr.name.name === "value" &&
        attr.value?.type === "JSXExpressionContainer"
      ) {
        return {
          inline: isInlineRefLiteral(attr.value.expression),
          loc: toLoc(comp.file, attr),
        };
      }
    }
    return { inline: false };
  };

  // provides edges dedup first-wins on `provides|<ctxId>`. If a later mount of
  // the same provider carries an inline value, upgrade the existing edge rather
  // than let the earlier inline=false edge swallow the re-render signal.
  const pushProvides = (
    ctxId: StateId,
    info: { inline: boolean; loc?: SourceLoc },
  ) => {
    const key = `provides|${ctxId}`;
    if (seen.has(key)) {
      if (!info.inline) return;
      const existing = edges.find(
        (e) => e.type === "provides" && e.from === comp.id && e.to === ctxId,
      );
      if (existing && existing.type === "provides" && !existing.inline) {
        existing.inline = true;
        existing.loc = info.loc;
      }
      return;
    }
    seen.add(key);
    edges.push({
      type: "provides",
      from: comp.id,
      to: ctxId,
      inline: info.inline,
      loc: info.loc,
    });
  };

  walk(comp.fn, (node) => {
    if (node.type !== "JSXOpeningElement") return;

    // <Ctx.Provider value={...}>
    if (
      node.name.type === "JSXMemberExpression" &&
      node.name.object.type === "JSXIdentifier" &&
      node.name.property.name === "Provider"
    ) {
      const ctxId = resolveContext(from, node.name.object.name, records);
      if (ctxId) pushProvides(ctxId, providerValue(node));
      return;
    }

    // React 19: <Ctx value={...}> — a bare context element used as provider.
    if (node.name.type === "JSXIdentifier") {
      const ctxId = resolveContext(from, node.name.name, records);
      if (ctxId) pushProvides(ctxId, providerValue(node));
    }
  });
}

// ─── Zustand adapter ───

/**
 * Matches `create(fn)` and the curried TS form `create<T>()(fn)`, but only
 * when `create` is imported from zustand — a bare name match would false-
 * positive on every other library's `create()`.
 */
function zustandCreateInitializer(
  init: TSESTree.Node,
  record: FileRecord,
): { fields?: string[] } | null {
  if (init.type !== "CallExpression") return null;

  const fromZustand = (name: string) =>
    record.imports.get(name)?.source.startsWith("zustand") === true;

  let initializerArg: TSESTree.Node | undefined;
  if (init.callee.type === "Identifier" && fromZustand(init.callee.name)) {
    initializerArg = init.arguments[0];
  } else if (
    init.callee.type === "CallExpression" &&
    init.callee.callee.type === "Identifier" &&
    fromZustand(init.callee.callee.name)
  ) {
    initializerArg = init.arguments[0]; // create<T>()(fn)
  } else {
    return null;
  }

  const fn = asFunction(initializerArg);
  if (!fn) return {};

  let objectBody: TSESTree.ObjectExpression | null = null;
  if (fn.body.type === "ObjectExpression") objectBody = fn.body;
  else if (fn.body.type === "BlockStatement") {
    for (const stmt of fn.body.body) {
      if (
        stmt.type === "ReturnStatement" &&
        stmt.argument?.type === "ObjectExpression"
      ) {
        objectBody = stmt.argument;
        break;
      }
    }
  }
  if (!objectBody) return {};

  const fields: string[] = [];
  for (const prop of objectBody.properties) {
    if (prop.type === "Property" && prop.key.type === "Identifier") {
      fields.push(prop.key.name);
    }
  }
  return { fields };
}

/** Resolve a store name in a file to its StateId — local first, then imports. */
function resolveStore(
  from: FileRecord,
  name: string,
  records: Map<string, FileRecord>,
): StateId | null {
  if (from.stores.has(name)) return `${from.path}#${name}`;

  const importRef = from.imports.get(name);
  if (!importRef) return null;
  const target = resolveModule(from.path, importRef.source, records);
  if (!target) return null;

  const localName = target.exports.get(importRef.imported);
  if (!localName || !target.stores.has(localName)) return null;
  return `${target.path}#${localName}`;
}

/** Is this selector the whole-store identity (`(s) => s`) — or missing entirely? */
function isWholeStoreRead(call: TSESTree.CallExpression): boolean {
  const selector = call.arguments[0];
  if (!selector) return true; // bare useStore()
  const fn = asFunction(selector);
  if (!fn) return false; // a named selector — assume it narrows
  const param = fn.params[0];
  return (
    param?.type === "Identifier" &&
    fn.body.type === "Identifier" &&
    fn.body.name === param.name
  );
}

/** Emit reads/writes edges for a component's zustand store usage. */
function analyzeStoreUsage(
  comp: ComponentInfo,
  from: FileRecord,
  records: Map<string, FileRecord>,
  edges: Edge[],
): void {
  const seen = new Set<string>();
  const push = (edge: Edge, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  walk(comp.fn, (node) => {
    if (node.type !== "CallExpression") return;

    // useStore() / useStore(selector)
    if (node.callee.type === "Identifier") {
      const storeId = resolveStore(from, node.callee.name, records);
      if (!storeId) return;
      const via = isWholeStoreRead(node) ? "hook" : "selector";
      push(
        { type: "reads", from: comp.id, to: storeId, via },
        `reads|${storeId}|${via}`,
      );
      return;
    }

    // useStore.setState(...)
    if (
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "setState"
    ) {
      const storeId = resolveStore(from, node.callee.object.name, records);
      if (storeId)
        push(
          { type: "writes", from: comp.id, to: storeId, via: "setState" },
          `writes|${storeId}`,
        );
    }
  });
}

// ─── Redux / RTK adapter ───

function importedFrom(
  record: FileRecord,
  name: string,
  prefix: string,
): boolean {
  return record.imports.get(name)?.source.startsWith(prefix) === true;
}

/** `createSlice({ name: 'cart', initialState: {...} })` — identity is the `name` prop. */
function rtkSliceDecl(
  init: TSESTree.Node,
  varName: string,
  loc: SourceLoc,
  record: FileRecord,
): SliceDecl | null {
  if (init.type !== "CallExpression") return null;
  if (init.callee.type !== "Identifier" || init.callee.name !== "createSlice")
    return null;
  if (!importedFrom(record, "createSlice", "@reduxjs/toolkit")) return null;

  const config = init.arguments[0];
  let sliceName = varName;
  let fields: string[] | undefined;
  if (config?.type === "ObjectExpression") {
    for (const prop of config.properties) {
      if (prop.type !== "Property" || prop.key.type !== "Identifier") continue;
      if (
        prop.key.name === "name" &&
        prop.value.type === "Literal" &&
        typeof prop.value.value === "string"
      ) {
        sliceName = prop.value.value;
      }
      if (
        prop.key.name === "initialState" &&
        prop.value.type === "ObjectExpression"
      ) {
        fields = [];
        for (const field of prop.value.properties) {
          if (field.type === "Property" && field.key.type === "Identifier") {
            fields.push(field.key.name);
          }
        }
      }
    }
  }
  return { sliceName, loc, fields };
}

/** `createApi({ endpoints: (b) => ({ getUser: b.query(...) }) })` — collect query endpoints. */
function collectRtkApiEndpoints(
  init: TSESTree.Node,
  loc: SourceLoc,
  record: FileRecord,
): boolean {
  if (init.type !== "CallExpression") return false;
  if (init.callee.type !== "Identifier" || init.callee.name !== "createApi")
    return false;
  if (!importedFrom(record, "createApi", "@reduxjs/toolkit")) return false;

  const config = init.arguments[0];
  if (config?.type !== "ObjectExpression") return true;
  for (const prop of config.properties) {
    if (
      prop.type !== "Property" ||
      prop.key.type !== "Identifier" ||
      prop.key.name !== "endpoints"
    )
      continue;
    const builderFn = asFunction(prop.value);
    if (!builderFn) continue;

    let endpointsObject: TSESTree.ObjectExpression | null = null;
    if (builderFn.body.type === "ObjectExpression")
      endpointsObject = builderFn.body;
    else if (builderFn.body.type === "BlockStatement") {
      for (const stmt of builderFn.body.body) {
        if (
          stmt.type === "ReturnStatement" &&
          stmt.argument?.type === "ObjectExpression"
        ) {
          endpointsObject = stmt.argument;
          break;
        }
      }
    }
    if (!endpointsObject) continue;

    for (const endpoint of endpointsObject.properties) {
      if (endpoint.type !== "Property" || endpoint.key.type !== "Identifier")
        continue;
      // Only builder.query(...) endpoints are cached server reads; mutations aren't sources.
      if (
        endpoint.value.type === "CallExpression" &&
        endpoint.value.callee.type === "MemberExpression" &&
        endpoint.value.callee.property.type === "Identifier" &&
        endpoint.value.callee.property.name === "query"
      ) {
        record.rtkQueryEndpoints.set(endpoint.key.name, loc);
      }
    }
  }
  return true;
}

/** StateIds: slice identity is the slice name; endpoint identity is the endpoint name. */
function sliceStateId(sliceName: string): StateId {
  return `redux:${sliceName}`;
}
function rtkEndpointStateId(endpoint: string): StateId {
  return `rtkq:${endpoint}`;
}

/** `useGetUserQuery` → `getUser`; null when the name isn't a generated RTK hook. */
function rtkHookEndpoint(name: string): string | null {
  const match = /^use([A-Z]\w*)Query$/.exec(name);
  if (!match?.[1]) return null;
  return match[1].charAt(0).toLowerCase() + match[1].slice(1);
}

/** Which top-level state slices does a selector touch? `(s) => s.cart.items` → ['cart']. */
function selectorSliceNames(selectorArg: TSESTree.Node | undefined): string[] {
  const fn = asFunction(selectorArg);
  if (!fn) return []; // imported/named selector — cross-file selector analysis is v2
  const param = fn.params[0];
  const names = new Set<string>();

  if (param?.type === "ObjectPattern") {
    for (const prop of param.properties) {
      if (prop.type === "Property" && prop.key.type === "Identifier") {
        names.add(prop.key.name);
      }
    }
  } else if (param?.type === "Identifier") {
    const stateName = param.name;
    walk(fn.body, (node) => {
      if (
        node.type === "MemberExpression" &&
        node.object.type === "Identifier" &&
        node.object.name === stateName &&
        node.property.type === "Identifier" &&
        !node.computed
      ) {
        names.add(node.property.name);
      }
    });
  }
  return [...names];
}

/** Emit reads edges for useSelector slice access and generated RTK Query hooks. */
function analyzeReduxUsage(
  comp: ComponentInfo,
  from: FileRecord,
  edges: Edge[],
  sliceIdsByName: Map<string, StateId>,
  endpointIdsByName: Map<string, StateId>,
  unresolved: { selectorReads: number },
): void {
  const seen = new Set<string>();
  const push = (edge: Edge, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  walk(comp.fn, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier")
      return;
    const calleeName = node.callee.name;

    // useSelector from react-redux, or the typed useAppSelector convention.
    const isSelectorHook =
      (calleeName === "useSelector" &&
        importedFrom(from, "useSelector", "react-redux")) ||
      calleeName === "useAppSelector";
    if (isSelectorHook) {
      const sliceNames = selectorSliceNames(node.arguments[0]);
      if (sliceNames.length === 0) {
        // Imported/named selector — we can't attribute this read to a slice.
        // Record the miss so detectors don't claim exhaustive reader counts.
        unresolved.selectorReads++;
        return;
      }
      for (const sliceName of sliceNames) {
        const sliceId = sliceIdsByName.get(sliceName);
        if (sliceId)
          push(
            { type: "reads", from: comp.id, to: sliceId, via: "selector" },
            `reads|${sliceId}`,
          );
      }
      return;
    }

    // Generated RTK Query hooks: useGetUserQuery() → endpoint getUser.
    const endpoint = rtkHookEndpoint(calleeName);
    if (endpoint) {
      const endpointId = endpointIdsByName.get(endpoint);
      if (endpointId)
        push(
          { type: "reads", from: comp.id, to: endpointId, via: "hook" },
          `reads|${endpointId}`,
        );
    }
  });
}

// ─── Vue adapter (SFC script setup / pinia / provide-inject) ───

/** Vue reactivity imports come from 'vue' (or the standalone reactivity package). */
function importedFromVue(record: FileRecord, name: string): boolean {
  const source = record.imports.get(name)?.source;
  return source === "vue" || source === "@vue/reactivity";
}

/** Sources that mean "this IS the auto-imported Vue/Nuxt symbol". */
const VUE_AUTO_IMPORT_SOURCES = new Set([
  "vue",
  "@vue/reactivity",
  "#imports",
  "#app",
]);

/**
 * Nuxt (and unplugin-auto-import) expose Vue APIs without import statements,
 * so inside an SFC a bare `ref(...)` is Vue's unless the name is imported
 * from somewhere else or shadowed by a local declaration. Returns a predicate
 * scoped to one SFC: (name) => is this Vue's `name`?
 */
function vueNameResolver(
  record: FileRecord,
  program: TSESTree.Program,
): (name: string) => boolean {
  const locals = new Set<string>();
  walk(program, (node) => {
    if (node.type === "FunctionDeclaration" && node.id)
      locals.add(node.id.name);
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier")
      locals.add(node.id.name);
  });
  return (name: string): boolean => {
    const source = record.imports.get(name)?.source;
    if (source !== undefined) return VUE_AUTO_IMPORT_SOURCES.has(source);
    return !locals.has(name);
  };
}

/** Nuxt-only composables — seeing one called (unimported or from #app/#imports)
 * is the evidence that this codebase is Nuxt. */
const NUXT_MARKERS = new Set([
  "useFetch",
  "useLazyFetch",
  "useAsyncData",
  "useLazyAsyncData",
  "useNuxtApp",
  "useRuntimeConfig",
  "definePageMeta",
  "navigateTo",
  "useHead",
  "useSeoMeta",
]);

/** `defineStore('cart', …)` imported from pinia. Identity is the id string. */
function piniaStoreDecl(
  init: TSESTree.Node,
  varName: string,
  record: FileRecord,
): { storeId: string; fields?: string[] } | null {
  if (init.type !== "CallExpression") return null;
  if (init.callee.type !== "Identifier" || init.callee.name !== "defineStore")
    return null;
  // Nuxt auto-imports defineStore, so an unimported call counts too — but
  // then the id must be a string literal: stricter evidence for weaker
  // provenance. An import from any non-pinia module always disqualifies.
  const importSource = record.imports.get("defineStore")?.source;
  const fromPinia =
    importSource !== undefined &&
    (importSource.startsWith("pinia") || importSource.startsWith("#imports"));
  if (importSource !== undefined && !fromPinia) return null;

  const idArg = init.arguments[0];
  const isLiteralId =
    idArg?.type === "Literal" && typeof idArg.value === "string";
  if (!fromPinia && !isLiteralId) return null;
  const storeId = isLiteralId ? (idArg.value as string) : varName;

  const config = init.arguments[1];
  let fields: string[] | undefined;
  if (config?.type === "ObjectExpression") {
    // Options store: fields come from `state: () => ({ … })`.
    for (const prop of config.properties) {
      if (
        prop.type === "Property" &&
        prop.key.type === "Identifier" &&
        prop.key.name === "state"
      ) {
        fields = objectFnFields(prop.value);
      }
    }
  } else {
    // Setup store: fields are whatever the setup function returns.
    fields = objectFnFields(config);
  }
  return { storeId, fields };
}

/** Keys of the object a function returns — direct object body or return statement. */
function objectFnFields(node: TSESTree.Node | undefined): string[] | undefined {
  const fn = asFunction(node ?? null);
  if (!fn) return undefined;
  let obj: TSESTree.ObjectExpression | null = null;
  if (fn.body.type === "ObjectExpression") obj = fn.body;
  else if (fn.body.type === "BlockStatement") {
    for (const stmt of fn.body.body) {
      if (
        stmt.type === "ReturnStatement" &&
        stmt.argument?.type === "ObjectExpression"
      ) {
        obj = stmt.argument;
        break;
      }
    }
  }
  if (!obj) return undefined;
  const fields: string[] = [];
  for (const prop of obj.properties) {
    if (prop.type === "Property" && prop.key.type === "Identifier")
      fields.push(prop.key.name);
  }
  return fields;
}

/** StateId for a pinia store — the defineStore id is app-global, like query keys. */
function piniaStateId(storeId: string): StateId {
  return `pinia:${storeId}`;
}

/** Resolve a `use*Store` name to its pinia StateId — local first, then
 * imports, then (Nuxt auto-imports) a unique name match across the file set.
 * Ambiguous auto-import matches resolve to null rather than guess. */
function resolvePiniaStore(
  from: FileRecord,
  name: string,
  records: Map<string, FileRecord>,
): StateId | null {
  const local = from.piniaStores.get(name);
  if (local) return piniaStateId(local.storeId);

  const importRef = from.imports.get(name);
  if (importRef) {
    const target = resolveModule(from.path, importRef.source, records);
    if (!target) return null;
    const localName = target.exports.get(importRef.imported);
    const decl = localName ? target.piniaStores.get(localName) : undefined;
    return decl ? piniaStateId(decl.storeId) : null;
  }

  let match: StateId | null = null;
  for (const record of records.values()) {
    const decl = record.piniaStores.get(name);
    if (!decl) continue;
    const id = piniaStateId(decl.storeId);
    if (match !== null && match !== id) return null; // ambiguous — refuse
    match = id;
  }
  return match;
}

/** Identity for a provide/inject key: literal string, or the (import-resolved)
 * symbol name — cross-file symbols resolve to `file#name` so same-named
 * symbols in different modules never merge dishonestly. */
function injectKeyOf(
  from: FileRecord,
  keyArg: TSESTree.Node | undefined,
  records: Map<string, FileRecord>,
): { id: StateId; name: string } | null {
  if (keyArg?.type === "Literal" && typeof keyArg.value === "string") {
    return { id: `inject:${keyArg.value}`, name: keyArg.value };
  }
  if (keyArg?.type !== "Identifier") return null;
  const importRef = from.imports.get(keyArg.name);
  if (importRef) {
    const target = resolveModule(from.path, importRef.source, records);
    if (target) {
      const localName = target.exports.get(importRef.imported) ?? keyArg.name;
      return { id: `inject:${target.path}#${localName}`, name: localName };
    }
  }
  return { id: `inject:${keyArg.name}`, name: keyArg.name };
}

/**
 * Templates aren't parsed in v1, so a ref the template might write (v-model,
 * inline `x = …` / `x++`) must never be called pure-derived or a pure server
 * cache. Conservative regex over raw template text — biases toward silence.
 */
function templateMayMutate(template: string | null, name: string): boolean {
  if (!template) return false;
  const id = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`v-model(?:[:.][\\w.-]+)?\\s*=\\s*["']\\s*${id}\\b`).test(
      template,
    ) || new RegExp(`\\b${id}\\s*(?:=[^=>]|\\+\\+|--)`).test(template)
  );
}

/** defineProps extraction — type args, object/array arg, withDefaults wrapper. */
function collectVueProps(program: TSESTree.Program): VuePropsInfo {
  const info: VuePropsInfo = {
    names: new Set(),
    varName: null,
    destructured: new Set(),
  };

  const unwrapDefineProps = (
    node: TSESTree.Node | undefined,
  ): TSESTree.CallExpression | null => {
    if (node?.type !== "CallExpression") return null;
    if (node.callee.type !== "Identifier") return null;
    if (node.callee.name === "defineProps") return node;
    if (node.callee.name === "withDefaults")
      return unwrapDefineProps(node.arguments[0]);
    return null;
  };

  const collectNames = (call: TSESTree.CallExpression): void => {
    const typeArg = call.typeArguments?.params[0];
    if (typeArg?.type === "TSTypeLiteral") {
      for (const member of typeArg.members) {
        if (
          member.type === "TSPropertySignature" &&
          member.key.type === "Identifier"
        )
          info.names.add(member.key.name);
      }
    }
    const arg = call.arguments[0];
    if (arg?.type === "ObjectExpression") {
      for (const prop of arg.properties) {
        if (prop.type === "Property" && prop.key.type === "Identifier")
          info.names.add(prop.key.name);
      }
    } else if (arg?.type === "ArrayExpression") {
      for (const el of arg.elements) {
        if (el?.type === "Literal" && typeof el.value === "string")
          info.names.add(el.value);
      }
    }
  };

  walk(program, (node) => {
    if (node.type === "VariableDeclarator") {
      const call = unwrapDefineProps(node.init ?? undefined);
      if (!call) return;
      collectNames(call);
      if (node.id.type === "Identifier") info.varName = node.id.name;
      else if (node.id.type === "ObjectPattern") {
        for (const prop of node.id.properties) {
          if (prop.type === "Property" && prop.key.type === "Identifier")
            info.destructured.add(prop.key.name);
        }
      }
      return;
    }
    if (node.type === "ExpressionStatement") {
      const call = unwrapDefineProps(node.expression);
      if (call) collectNames(call);
    }
  });
  return info;
}

/** What one template contributes to the graph. */
interface VueTemplateUse {
  /** Root identifiers the template reads (v-for locals excluded). */
  reads: Set<string>;
  /** Names the template mutates (v-model targets, `x = …` in handlers). */
  mutated: Set<string>;
  /** `:prop="expr"` observations on component tags. */
  propPasses: VuePropPass[];
}

/**
 * One walk over the template AST. Pure-identifier binds to components are
 * forwards, not reads — mirroring the JSX path's forward detection.
 */
function scanVueTemplate(comp: VueComponentInfo): VueTemplateUse {
  const use: VueTemplateUse = {
    reads: new Set(),
    mutated: new Set(),
    propPasses: [],
  };
  const ast = comp.templateAst;
  if (!ast) return use;

  // Pre-pass: v-for iterator and slot-prop names shadow state for the whole
  // template (conservative: real reads of same-named state go unseen).
  const locals = new Set<string>();
  walkTemplate(ast, (node) => {
    if (node.type !== TPL_ELEMENT) return;
    for (const p of (node as TplElement).props) {
      if (p.type === TPL_DIRECTIVE && p.name === "for" && p.exp) {
        for (const name of vForLocals(p.exp.content)) locals.add(name);
      }
      if (p.type === TPL_DIRECTIVE && p.name === "slot" && p.exp) {
        for (const name of identifiersIn(p.exp.content)) locals.add(name);
      }
    }
  });

  const readAll = (exp: string): void => {
    for (const name of identifiersIn(exp)) {
      if (!locals.has(name)) use.reads.add(name);
    }
  };

  walkTemplate(ast, (node) => {
    if (node.type === TPL_INTERPOLATION) {
      readAll((node as TplInterpolation).content.content);
      return;
    }
    if (node.type !== TPL_ELEMENT) return;
    const el = node as TplElement;
    const isComponent = el.tagType === TAG_COMPONENT;

    for (const p of el.props) {
      if (p.type !== TPL_DIRECTIVE) continue;
      const exp = p.exp?.content;

      if (p.name === "bind" && p.arg?.content) {
        if (exp === undefined) continue;
        const pureIdentifier = /^[A-Za-z_$][\w$]*$/.test(exp.trim());
        if (isComponent) {
          use.propPasses.push({
            fromComponentId: comp.id,
            fromFile: comp.file,
            childTag: el.tag,
            prop: camelize(p.arg.content),
            inline: /^\s*[[{(]/.test(exp) || /=>/.test(exp),
            loc: { file: comp.file, line: p.loc.start.line, col: 0 },
          });
          // A pure-identifier bind is a forward; anything computed reads its inputs.
          if (!pureIdentifier) readAll(exp);
        } else {
          readAll(exp);
        }
        continue;
      }

      if (p.name === "model" && exp) {
        const root = /^[A-Za-z_$][\w$]*/.exec(exp.trim())?.[0];
        if (root && !locals.has(root)) {
          use.mutated.add(root);
          use.reads.add(root);
        }
        continue;
      }

      if (p.name === "on" && exp) {
        for (const name of identifiersIn(exp)) {
          if (locals.has(name)) continue;
          use.reads.add(name);
          if (expressionMutates(exp, name)) use.mutated.add(name);
        }
        continue;
      }

      // v-if / v-show / v-for RHS / custom directives — expressions are reads.
      if (exp) readAll(exp);
    }
  });

  return use;
}

/** Resolve a template tag to an SFC — script-setup import first, then a
 * unique name match across the file set (Nuxt auto-registration). */
function resolveVueComponentByTag(
  from: FileRecord,
  tag: string,
  records: Map<string, FileRecord>,
): VueComponentInfo | null {
  const pascal = pascalize(tag);
  const importRef = from.imports.get(pascal) ?? from.imports.get(tag);
  if (importRef) {
    const target = resolveModule(from.path, importRef.source, records);
    return target?.vueComponent ?? null;
  }
  let match: VueComponentInfo | null = null;
  for (const record of records.values()) {
    const comp = record.vueComponent;
    if (!comp || comp.name !== pascal) continue;
    if (match !== null) return null; // ambiguous — refuse to guess
    match = comp;
  }
  return match;
}

/**
 * Does the child use the prop beyond forwarding it? Undeclared props fall
 * through as attrs (that IS usage), so only a declared prop whose sole
 * template occurrences are pure-identifier binds to components counts blind.
 */
function vueChildReadsProp(child: VueComponentInfo, prop: string): boolean {
  if (!child.props.names.has(prop)) return true;

  // Script side: `props.x` member access, or a destructured `x` reference.
  let scriptReads = false;
  walk(child.program, (node) => {
    if (scriptReads) return;
    if (
      child.props.varName !== null &&
      node.type === "MemberExpression" &&
      !node.computed &&
      node.object.type === "Identifier" &&
      node.object.name === child.props.varName &&
      node.property.type === "Identifier" &&
      node.property.name === prop
    ) {
      scriptReads = true;
    }
  });
  if (!scriptReads && child.props.destructured.has(prop)) {
    let count = 0;
    walk(child.program, (node) => {
      if (node.type === "Identifier" && node.name === prop) count++;
    });
    // More references than the destructure binding itself = a real use.
    if (count > 1) scriptReads = true;
  }
  // Options API child: a prop is read in script as `this.propName`.
  if (!scriptReads && !child.setup) {
    walk(child.program, (node) => {
      if (scriptReads) return;
      if (thisMemberName(node) === prop) scriptReads = true;
    });
  }
  if (scriptReads) return true;

  // Template side: any non-forward occurrence.
  const ast = child.templateAst;
  if (!ast) return true; // can't see the template — never claim blind
  let reads = false;
  walkTemplate(ast, (node) => {
    if (reads) return;
    if (node.type === TPL_INTERPOLATION) {
      if (identifiersIn((node as TplInterpolation).content.content).has(prop))
        reads = true;
      return;
    }
    if (node.type !== TPL_ELEMENT) return;
    const el = node as TplElement;
    const isComponent = el.tagType === TAG_COMPONENT;
    for (const p of el.props) {
      if (p.type !== TPL_DIRECTIVE || !p.exp) continue;
      const exp = p.exp.content;
      if (!identifiersIn(exp).has(prop)) continue;
      const pureForward =
        isComponent &&
        p.name === "bind" &&
        p.arg?.content !== undefined &&
        exp.trim() === prop;
      if (!pureForward) reads = true;
    }
  });
  return reads;
}

const VUE_LIFECYCLE_HOOKS = new Set([
  "onMounted",
  "onBeforeMount",
  "onActivated",
  "watch",
  "watchEffect",
  "watchPostEffect",
]);

/** Sync watchers derive; lifecycle mounts initialize — only watchers count. */
const VUE_WATCHERS = new Set(["watch", "watchEffect", "watchPostEffect"]);

/** Registered per-run so buildStateGraph can turn keys into sources. */
type InjectDecls = Map<StateId, { name: string; loc: SourceLoc }>;

/** The reactive bindings a script-setup scope declares, keyed by local name. */
interface VueReactiveMaps {
  refNames: Map<string, StateId>;
  reactiveNames: Map<string, StateId>;
  computedNames: Map<string, StateId>;
  storeVars: Map<string, StateId>;
}

function emptyVueReactiveMaps(): VueReactiveMaps {
  return {
    refNames: new Map(),
    reactiveNames: new Map(),
    computedNames: new Map(),
    storeVars: new Map(),
  };
}

/** Look up a binding name across every reactive-source kind. */
function lookupVueBinding(maps: VueReactiveMaps, name: string): StateId | null {
  return (
    maps.refNames.get(name) ??
    maps.reactiveNames.get(name) ??
    maps.computedNames.get(name) ??
    maps.storeVars.get(name) ??
    null
  );
}

/**
 * Pass 1 — declare ref/reactive/computed sources + bind pinia stores, walking
 * `scope` (the whole program for `<script setup>`, or the setup() function body
 * for the Options-API setup() option). Populates `maps`.
 */
function declareVueReactiveSources(
  scope: TSESTree.Node,
  comp: VueComponentInfo,
  record: FileRecord,
  records: Map<string, FileRecord>,
  sources: Map<StateId, StateSource>,
  edges: Edge[],
  isVueName: (name: string) => boolean,
  maps: VueReactiveMaps,
): void {
  const declareSource = (
    name: string,
    node: TSESTree.Node,
    kind: "ref" | "reactive" | "computed",
    classification: StateClass,
    fields?: string[],
  ): StateId => {
    const stateId: StateId = `${comp.file}#${comp.name}.${name}`;
    sources.set(stateId, {
      id: stateId,
      kind,
      classification,
      name,
      loc: toLoc(comp.file, node),
      ownerComponentId: comp.id,
      shape: fields ? { kind: "object", fields } : undefined,
      fieldCount: fields?.length,
    });
    edges.push({ type: "declares", from: comp.id, to: stateId });
    return stateId;
  };

  walk(scope, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier")
      return;
    if (node.init?.type !== "CallExpression") return;
    const callee = node.init.callee;
    if (callee.type !== "Identifier") return;
    const name = node.id.name;

    if (
      (callee.name === "ref" || callee.name === "shallowRef") &&
      isVueName(callee.name)
    ) {
      maps.refNames.set(name, declareSource(name, node, "ref", "local"));
      return;
    }
    if (callee.name === "reactive" && isVueName("reactive")) {
      const arg = node.init.arguments[0];
      const fields: string[] = [];
      if (arg?.type === "ObjectExpression") {
        for (const prop of arg.properties) {
          if (prop.type === "Property" && prop.key.type === "Identifier")
            fields.push(prop.key.name);
        }
      }
      maps.reactiveNames.set(
        name,
        declareSource(name, node, "reactive", "local", fields),
      );
      return;
    }
    if (callee.name === "computed" && isVueName("computed")) {
      // computed IS derived state done right — classified derived, never flagged.
      maps.computedNames.set(
        name,
        declareSource(name, node, "computed", "derived"),
      );
      return;
    }
    if (isHookName(callee.name)) {
      const piniaId = resolvePiniaStore(record, callee.name, records);
      if (piniaId) maps.storeVars.set(name, piniaId);
    }
  });
}

/**
 * Pass 2 — reads/writes, storeToRefs, $patch, provide/inject edges, walking
 * `scope`. Uses the binding `maps` populated by declareVueReactiveSources.
 */
function emitVueReactiveEdges(
  scope: TSESTree.Node,
  comp: VueComponentInfo,
  record: FileRecord,
  records: Map<string, FileRecord>,
  parents: ParentMap,
  injectDecls: InjectDecls,
  isVueName: (name: string) => boolean,
  maps: VueReactiveMaps,
  push: (edge: Edge, key: string) => void,
): void {
  walk(scope, (node) => {
    // x.value = … / obj.field = … / store.field = … are writes, not reads.
    if (node.type === "AssignmentExpression") {
      const left = node.left;
      if (
        left.type === "MemberExpression" &&
        left.object.type === "Identifier" &&
        left.property.type === "Identifier"
      ) {
        const objName = left.object.name;
        if (left.property.name === "value") {
          const refId = maps.refNames.get(objName);
          if (refId) {
            push(
              { type: "writes", from: comp.id, to: refId, via: "setter" },
              `writes|${refId}`,
            );
            return;
          }
        }
        const reactiveId = maps.reactiveNames.get(objName);
        if (reactiveId) {
          push(
            { type: "writes", from: comp.id, to: reactiveId, via: "mutate" },
            `writes|${reactiveId}`,
          );
          return;
        }
        const storeId = maps.storeVars.get(objName);
        if (storeId) {
          push(
            { type: "writes", from: comp.id, to: storeId, via: "mutate" },
            `writes|${storeId}|mutate`,
          );
        }
      }
      return;
    }

    // const { items } = storeToRefs(store) — a narrowed subscription.
    if (
      node.type === "VariableDeclarator" &&
      node.init?.type === "CallExpression" &&
      node.init.callee.type === "Identifier" &&
      node.init.callee.name === "storeToRefs" &&
      // pinia import or (Nuxt) auto-import — a foreign import disqualifies
      (importedFrom(record, "storeToRefs", "pinia") ||
        !record.imports.has("storeToRefs"))
    ) {
      const arg = node.init.arguments[0];
      let storeId: StateId | null = null;
      if (arg?.type === "Identifier")
        storeId = maps.storeVars.get(arg.name) ?? null;
      else if (
        arg?.type === "CallExpression" &&
        arg.callee.type === "Identifier"
      ) {
        storeId = resolvePiniaStore(record, arg.callee.name, records);
      }
      if (storeId) {
        push(
          { type: "reads", from: comp.id, to: storeId, via: "selector" },
          `reads|${storeId}|selector`,
        );
      }
      return;
    }

    // store.$patch(…) — a batched write.
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "$patch"
    ) {
      const storeId = maps.storeVars.get(node.callee.object.name);
      if (storeId) {
        push(
          { type: "writes", from: comp.id, to: storeId, via: "setState" },
          `writes|${storeId}|patch`,
        );
      }
      return;
    }

    // store.$subscribe(cb) — a whole-store subscription: the callback fires on
    // every mutation of every field. Emitted as a `reads` via "subscribe" only
    // when `store` is a bound pinia store (maps.storeVars) — the same gate as
    // $patch above. Since emitVueReactiveEdges only ever walks a component's
    // `<script setup>` or an Options `setup()` body (never a store's own
    // defineStore body, which has no self-binding), the edge's `from` is always
    // a component/composable scope. A $subscribe inside a store definition file
    // produces no such binding and no edge, so the over-broad detector can't
    // fire on it.
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "$subscribe"
    ) {
      const storeId = maps.storeVars.get(node.callee.object.name);
      if (storeId) {
        push(
          { type: "reads", from: comp.id, to: storeId, via: "subscribe" },
          `reads|${storeId}|subscribe`,
        );
      }
      return;
    }

    // provide('key', v) / inject('key') — Vue's context.
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      (node.callee.name === "provide" || node.callee.name === "inject") &&
      isVueName(node.callee.name)
    ) {
      const key = injectKeyOf(record, node.arguments[0], records);
      if (!key) return;
      if (!injectDecls.has(key.id)) {
        injectDecls.set(key.id, {
          name: key.name,
          loc: toLoc(comp.file, node),
        });
      }
      if (node.callee.name === "provide") {
        push(
          { type: "provides", from: comp.id, to: key.id },
          `provides|${key.id}`,
        );
      } else {
        push(
          { type: "consumes", from: comp.id, to: key.id, via: "context" },
          `consumes|${key.id}`,
        );
      }
      return;
    }

    // Plain reads of ref/reactive/computed bindings.
    if (node.type === "Identifier") {
      const parent = parents.get(node);
      if (isNonValuePosition(node, parent)) return;
      const stateId =
        maps.refNames.get(node.name) ??
        maps.reactiveNames.get(node.name) ??
        maps.computedNames.get(node.name);
      if (!stateId) return;
      // Skip when this identifier is the object of an assignment target —
      // that occurrence is the write handled above.
      if (parent?.type === "MemberExpression" && parent.object === node) {
        const container = parents.get(parent);
        if (
          container?.type === "AssignmentExpression" &&
          container.left === parent
        )
          return;
      }
      push(
        { type: "reads", from: comp.id, to: stateId, via: "hook" },
        `reads|${stateId}`,
      );
    }
  });
}

/** Vue SFC analysis: reactive sources, reads/writes, pinia usage, provide/inject. */
function analyzeVueComponent(
  comp: VueComponentInfo,
  record: FileRecord,
  records: Map<string, FileRecord>,
  parents: ParentMap,
  sources: Map<StateId, StateSource>,
  edges: Edge[],
  injectDecls: InjectDecls,
  vuePropPasses: VuePropPass[],
): void {
  const seen = new Set<string>();
  const push = (edge: Edge, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  const maps = emptyVueReactiveMaps();
  const isVueName = vueNameResolver(record, comp.program);

  declareVueReactiveSources(
    comp.program,
    comp,
    record,
    records,
    sources,
    edges,
    isVueName,
    maps,
  );
  emitVueReactiveEdges(
    comp.program,
    comp,
    record,
    records,
    parents,
    injectDecls,
    isVueName,
    maps,
    push,
  );

  // Template pass: reads edges for bindings the script never touches,
  // prop passes for the drill chain, and the precise mutation guard.
  const templateUse = scanVueTemplate(comp);
  for (const name of templateUse.reads) {
    const stateId = lookupVueBinding(maps, name);
    if (!stateId) continue;
    push(
      { type: "reads", from: comp.id, to: stateId, via: "hook" },
      `reads|${stateId}`,
    );
  }
  vuePropPasses.push(...templateUse.propPasses);

  const templateMutates =
    comp.templateAst !== null
      ? (name: string) => templateUse.mutated.has(name)
      : (name: string) => templateMayMutate(comp.template, name);

  reclassifyVueFedState(
    comp,
    isVueName,
    maps.refNames,
    maps.reactiveNames,
    sources,
    parents,
    templateMutates,
  );
}

/**
 * Resolve an assignment LHS to the reactive source it feeds, using the same
 * single-level shape as emitVueReactiveEdges: `ref.value = …` for refs and
 * `state.prop = …` (any single-level property) for reactive objects.
 * Reactive attribution is object-level — the StateId is the binding, not the
 * property — so nested writes (`state.a.b = …`) stay out of scope, mirroring
 * the edge behavior.
 */
function resolveVueFedTarget(
  left: TSESTree.Node,
  refNames: Map<string, StateId>,
  reactiveNames: Map<string, StateId>,
): StateId | null {
  if (
    left.type !== "MemberExpression" ||
    left.object.type !== "Identifier" ||
    left.property.type !== "Identifier"
  )
    return null;
  if (left.property.name === "value") {
    const refId = refNames.get(left.object.name);
    if (refId) return refId;
  }
  return reactiveNames.get(left.object.name) ?? null;
}

/**
 * Vue mirror of reclassifyServerFedState: a ref/reactive assigned inside async
 * lifecycle work (onMounted + fetch, async watch) is a hand-rolled server
 * cache; a ref/reactive recomputed by a SYNC watcher is derived state that
 * should be a computed. onMounted sync assignment is one-time init — never
 * derived. Reactive attribution is object-level (see resolveVueFedTarget), so
 * any single property fed or edited moves the whole binding.
 */
function reclassifyVueFedState(
  comp: VueComponentInfo,
  isVueName: (name: string) => boolean,
  refNames: Map<string, StateId>,
  reactiveNames: Map<string, StateId>,
  sources: Map<StateId, StateSource>,
  parents: ParentMap,
  templateMutates: (name: string) => boolean,
): void {
  const callbacks = new Set<TSESTree.Node>();

  walk(comp.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier")
      return;
    const calleeName = node.callee.name;
    if (!VUE_LIFECYCLE_HOOKS.has(calleeName)) return;
    if (!isVueName(calleeName)) return;
    const cb = asFunction(
      calleeName === "watch" ? node.arguments[1] : node.arguments[0],
    );
    if (!cb) return;
    callbacks.add(cb);

    let asyncWork = cb.async === true;
    const fedDirect = new Set<StateId>();
    const fedNested = new Set<StateId>();
    walk(cb.body, (inner) => {
      if (inner.type === "AwaitExpression") asyncWork = true;
      if (
        inner.type === "Identifier" &&
        (inner.name === "fetch" || inner.name === "axios")
      )
        asyncWork = true;
      if (inner.type !== "AssignmentExpression") return;
      const stateId = resolveVueFedTarget(inner.left, refNames, reactiveNames);
      if (!stateId) return;
      // Nested callbacks (.then handlers, timers, subscriptions) are
      // event/async-driven feeds, not direct recomputation.
      let nested = false;
      let cursor: TSESTree.Node | undefined = parents.get(inner);
      while (cursor && cursor !== cb) {
        if (
          cursor.type === "ArrowFunctionExpression" ||
          cursor.type === "FunctionExpression" ||
          cursor.type === "FunctionDeclaration"
        ) {
          nested = true;
          break;
        }
        cursor = parents.get(cursor);
      }
      (nested ? fedNested : fedDirect).add(stateId);
    });

    const effectLoc = toLoc(comp.file, node);
    if (asyncWork) {
      for (const stateId of [...fedDirect, ...fedNested]) {
        const source = sources.get(stateId);
        if (!source) continue;
        source.classification = "server-cache";
        source.serverFed ??= { effect: effectLoc, editedOutsideEffect: false };
      }
      return;
    }

    if (!VUE_WATCHERS.has(calleeName)) return;
    for (const stateId of fedDirect) {
      if (fedNested.has(stateId)) continue;
      const source = sources.get(stateId);
      if (!source || source.serverFed) continue;
      source.derivedSync ??= { effect: effectLoc, editedOutsideEffect: false };
    }
  });

  if (callbacks.size === 0) return;

  // A ref `.value` (or reactive property) assignment outside every lifecycle
  // callback means other logic writes this source too — draft for server-fed,
  // disqualifier for derived.
  walk(comp.program, (node) => {
    if (node.type !== "AssignmentExpression") return;
    const stateId = resolveVueFedTarget(node.left, refNames, reactiveNames);
    if (!stateId) return;
    const source = sources.get(stateId);
    if (!source?.serverFed && !source?.derivedSync) return;
    let cursor: TSESTree.Node | undefined = node;
    while (cursor) {
      if (callbacks.has(cursor)) return;
      cursor = parents.get(cursor);
    }
    if (source.serverFed) source.serverFed.editedOutsideEffect = true;
    if (source.derivedSync) source.derivedSync.editedOutsideEffect = true;
  });

  // Finalize, guarding against template writes (AST-precise when available,
  // conservative regex otherwise).
  for (const [name, stateId] of [...refNames, ...reactiveNames]) {
    const source = sources.get(stateId);
    if (!source) continue;
    if (templateMutates(name)) {
      if (source.serverFed) source.serverFed.editedOutsideEffect = true;
      if (source.derivedSync) source.derivedSync.editedOutsideEffect = true;
    }
    if (source.derivedSync && !source.derivedSync.editedOutsideEffect) {
      source.classification = "derived";
    }
  }
}

// ─── Vue adapter (Options API SFC — data/computed/props/inject/provide) ───

/** Options lifecycle hooks that run once and may fetch — server-cache feeders. */
const OPTIONS_LIFECYCLE_HOOKS = new Set(["created", "mounted", "beforeMount"]);

/** Promise-continuation methods: a `this.x = …` inside one of these callbacks
 * is still fetch-fed (`axios.get(url).then(r => this.items = r.data)`), unlike
 * an addEventListener/setInterval callback, which is event-driven. */
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);

function isFunctionLike(node: TSESTree.Node): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

/** `this.x` (non-computed member of ThisExpression) → 'x'; otherwise null. */
function thisMemberName(node: TSESTree.Node): string | null {
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "ThisExpression" &&
    node.property.type === "Identifier"
  )
    return node.property.name;
  return null;
}

/** Is this function the callback argument of a `.then/.catch/.finally` call? */
function isPromiseCallback(fn: TSESTree.Node, parents: ParentMap): boolean {
  const parent = parents.get(fn);
  if (parent?.type !== "CallExpression") return false;
  if (!parent.arguments.includes(fn as TSESTree.CallExpressionArgument))
    return false;
  const callee = parent.callee;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    PROMISE_METHODS.has(callee.property.name)
  );
}

/** True when the only function boundaries between `node` and `hookFn` are
 * promise-continuation callbacks (or none) — the fetch-fed assignment shape. */
function withinFetchChain(
  node: TSESTree.Node,
  hookFn: TSESTree.Node,
  parents: ParentMap,
): boolean {
  let cursor: TSESTree.Node | undefined = parents.get(node);
  while (cursor && cursor !== hookFn) {
    if (isFunctionLike(cursor) && !isPromiseCallback(cursor, parents))
      return false;
    cursor = parents.get(cursor);
  }
  return cursor === hookFn;
}

/** True when a function boundary sits between `node` and `fn` — i.e. `node` is
 * not directly in `fn`'s body (it's in a nested callback). */
function nestedInFunction(
  node: TSESTree.Node,
  fn: TSESTree.Node,
  parents: ParentMap,
): boolean {
  let cursor: TSESTree.Node | undefined = parents.get(node);
  while (cursor && cursor !== fn) {
    if (isFunctionLike(cursor)) return true;
    cursor = parents.get(cursor);
  }
  return false;
}

/** A non-computed `{ key: … }` / `key() {}` property named `name`. */
function optionProp(
  obj: TSESTree.ObjectExpression,
  name: string,
): TSESTree.Property | null {
  for (const p of obj.properties) {
    if (
      p.type === "Property" &&
      !p.computed &&
      p.key.type === "Identifier" &&
      p.key.name === name
    )
      return p;
  }
  return null;
}

/** The static name of a property key (`Identifier` or string `Literal`). */
function propKeyName(p: TSESTree.Property): string | null {
  if (p.computed) return null;
  if (p.key.type === "Identifier") return p.key.name;
  if (p.key.type === "Literal" && typeof p.key.value === "string")
    return p.key.value;
  return null;
}

/** The ObjectExpression a function returns — direct arrow body `() => ({…})`
 * or a `return {…}` statement. */
function optionsFnReturnObject(
  node: TSESTree.Node | undefined,
): TSESTree.ObjectExpression | null {
  const fn = asFunction(node ?? null);
  if (!fn) return null;
  if (fn.body.type === "ObjectExpression") return fn.body;
  if (fn.body.type === "BlockStatement") {
    for (const stmt of fn.body.body) {
      if (
        stmt.type === "ReturnStatement" &&
        stmt.argument?.type === "ObjectExpression"
      )
        return stmt.argument;
    }
  }
  return null;
}

/**
 * Locate the component options object from `export default`:
 * `export default {…}` or `export default defineComponent({…})` (defineComponent
 * imported from vue or Nuxt-auto-imported). Anything else — `export default
 * Identifier`, `Vue.extend(…)`, class components — is unrecognized: null, so
 * the caller counts it unresolved.
 */
function findOptionsObject(
  program: TSESTree.Program,
  isVueName: (name: string) => boolean,
): TSESTree.ObjectExpression | null {
  for (const stmt of program.body) {
    if (stmt.type !== "ExportDefaultDeclaration") continue;
    const decl = stmt.declaration;
    if (decl.type === "ObjectExpression") return decl;
    if (
      decl.type === "CallExpression" &&
      decl.callee.type === "Identifier" &&
      decl.callee.name === "defineComponent" &&
      isVueName("defineComponent") &&
      decl.arguments[0]?.type === "ObjectExpression"
    )
      return decl.arguments[0];
    return null; // export default of an unrecognized shape
  }
  return null;
}

/** Resolve an inject key from an object-form `inject` entry. The FROM key is
 * the value (`{ local: 'from' }` / `{ local: fromSymbol }` /
 * `{ local: { from: 'key' } }`); a bare object with no `from` injects under
 * the local property name. */
function optionsInjectObjectKey(
  from: FileRecord,
  p: TSESTree.Property,
  records: Map<string, FileRecord>,
): { id: StateId; name: string } | null {
  const value = p.value;
  if (value.type === "Literal" || value.type === "Identifier")
    return injectKeyOf(from, value, records);
  if (value.type === "ObjectExpression") {
    const fromProp = optionProp(value, "from");
    if (fromProp) return injectKeyOf(from, fromProp.value, records);
    const name = propKeyName(p);
    if (name) return { id: `inject:${name}`, name };
  }
  return null;
}

/** Resolve the injection key a `provide` object entry provides under. Computed
 * keys (`[MySymbol]: v`) resolve like inject symbols; static keys are strings. */
function optionsProvideKey(
  from: FileRecord,
  p: TSESTree.Property,
  records: Map<string, FileRecord>,
): { id: StateId; name: string } | null {
  if (p.computed && p.key.type === "Identifier")
    return injectKeyOf(from, p.key, records);
  const name = propKeyName(p);
  if (name) return { id: `inject:${name}`, name };
  return null;
}

/** Which reads/writes edge each pinia Options-API map helper implies. */
const PINIA_MAP_HELPER_EDGES: Record<
  string,
  { reads?: ReadVia; writes?: WriteVia }
> = {
  mapStores: { reads: "hook" },
  mapState: { reads: "selector" },
  mapGetters: { reads: "selector" },
  mapActions: { writes: "setState" },
  mapWritableState: { reads: "selector", writes: "mutate" },
};

/** Emit the reads/writes edge(s) a map helper implies for one store target. */
function emitMapHelperEdges(
  storeId: StateId,
  spec: { reads?: ReadVia; writes?: WriteVia },
  compId: ComponentId,
  push: (edge: Edge, key: string) => void,
): void {
  if (spec.reads)
    push(
      { type: "reads", from: compId, to: storeId, via: spec.reads },
      `reads|${storeId}|${spec.reads}`,
    );
  if (spec.writes)
    push(
      { type: "writes", from: compId, to: storeId, via: spec.writes },
      `writes|${storeId}|${spec.writes}`,
    );
}

/**
 * Pinia's Options-API map helpers in `computed:`/`methods:` spreads:
 * `...mapStores(useCartStore)` (hook), `...mapState/mapGetters(useCartStore,…)`
 * (selector reads), `...mapActions(…)` (setState writes), `...mapWritableState`
 * (selector reads + mutate writes). Store resolves via the hook-name first arg
 * (mapStores takes several hook names); the key list (array or object form) is
 * store-granular here, so it doesn't change the edge.
 */
function analyzePiniaMapHelpers(
  scope: TSESTree.Node,
  record: FileRecord,
  records: Map<string, FileRecord>,
  compId: ComponentId,
  push: (edge: Edge, key: string) => void,
): void {
  walk(scope, (node) => {
    if (node.type !== "SpreadElement") return;
    const call = node.argument;
    if (call.type !== "CallExpression" || call.callee.type !== "Identifier")
      return;
    const spec = PINIA_MAP_HELPER_EDGES[call.callee.name];
    if (!spec) return;
    if (!importedFrom(record, call.callee.name, "pinia")) return;

    const hookArgs =
      call.callee.name === "mapStores"
        ? call.arguments
        : call.arguments.slice(0, 1);
    for (const arg of hookArgs) {
      if (arg.type !== "Identifier") continue;
      const storeId = resolvePiniaStore(record, arg.name, records);
      if (storeId) emitMapHelperEdges(storeId, spec, compId, push);
    }
  });
}

// ─── Vuex adapter (createStore / this.$store / map helpers / useStore) ───

/** Which reads/writes edge each Vuex map helper implies. */
const VUEX_MAP_HELPER_EDGES: Record<
  string,
  { reads?: ReadVia; writes?: WriteVia }
> = {
  mapState: { reads: "selector" },
  mapGetters: { reads: "selector" },
  mapMutations: { writes: "dispatch" },
  mapActions: { writes: "dispatch" },
};

/** First namespace segment of a Vuex path string (`'cart/add'` → `'cart'`). */
function vuexNamespaceSegment(s: string): string {
  const i = s.indexOf("/");
  return i === -1 ? s : s.slice(0, i);
}

/** Attribute a segment to `vuex:<module>` when it names a module, else root. */
function vuexTargetId(
  segment: string | null,
  moduleNames: Set<string>,
): StateId {
  return segment && moduleNames.has(segment) ? `vuex:${segment}` : "vuex:root";
}

/** State fields of a Vuex config/module object — `state: {…}` or `state()`/
 * `state: () => ({…})`. */
function vuexStateFields(
  config: TSESTree.ObjectExpression,
): string[] | undefined {
  const stateProp = optionProp(config, "state");
  if (!stateProp) return undefined;
  const v = stateProp.value;
  if (v.type === "ObjectExpression") {
    const fields: string[] = [];
    for (const p of v.properties) {
      if (p.type === "Property" && p.key.type === "Identifier")
        fields.push(p.key.name);
    }
    return fields;
  }
  return objectFnFields(v);
}

/** Is a member expression the `this.$store` receiver? */
function isDollarStore(node: TSESTree.Node): boolean {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "ThisExpression" &&
    node.property.type === "Identifier" &&
    node.property.name === "$store"
  );
}

/**
 * Vuex usage in one Vue component: `this.$store.state.X`/`.getters.X` reads
 * (selector, attributed to a module when the first segment names one),
 * `this.$store.commit/dispatch(...)` writes (dispatch, attributed by the
 * literal action's namespace), the `mapState/mapGetters/mapMutations/mapActions`
 * option spreads (with namespace-string first-arg attribution), and Composition
 * `useStore()` reads (hook, on root). Only runs when a Vuex store was found, so
 * every edge lands on a registered source.
 */
function analyzeVuexUsage(
  comp: VueComponentInfo,
  record: FileRecord,
  parents: ParentMap,
  edges: Edge[],
  moduleNames: Set<string>,
): void {
  const seen = new Set<string>();
  const push = (edge: Edge, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  walk(comp.program, (node) => {
    // this.$store.state.X / this.$store.getters.X → reads (selector).
    if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.property.type === "Identifier" &&
      (node.property.name === "state" || node.property.name === "getters") &&
      isDollarStore(node.object)
    ) {
      const parent = parents.get(node);
      let segment: string | null = null;
      if (parent?.type === "MemberExpression" && parent.object === node) {
        if (!parent.computed && parent.property.type === "Identifier")
          segment = parent.property.name;
        else if (
          parent.computed &&
          parent.property.type === "Literal" &&
          typeof parent.property.value === "string"
        )
          segment = vuexNamespaceSegment(parent.property.value);
      }
      const target = vuexTargetId(segment, moduleNames);
      push(
        { type: "reads", from: comp.id, to: target, via: "selector" },
        `reads|${target}|selector`,
      );
      return;
    }

    // this.$store.commit(...) / .dispatch(...) → writes (dispatch).
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.property.type === "Identifier" &&
      (node.callee.property.name === "commit" ||
        node.callee.property.name === "dispatch") &&
      isDollarStore(node.callee.object)
    ) {
      const arg0 = node.arguments[0];
      let segment: string | null = null;
      if (arg0?.type === "Literal" && typeof arg0.value === "string")
        segment = vuexNamespaceSegment(arg0.value);
      else if (arg0?.type === "ObjectExpression") {
        const typeProp = optionProp(arg0, "type");
        if (
          typeProp?.value.type === "Literal" &&
          typeof typeProp.value.value === "string"
        )
          segment = vuexNamespaceSegment(typeProp.value.value);
      }
      const target = vuexTargetId(segment, moduleNames);
      push(
        { type: "writes", from: comp.id, to: target, via: "dispatch" },
        `writes|${target}|dispatch`,
      );
      return;
    }

    // Composition API useStore() from vuex → reads (hook) on root.
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "useStore" &&
      importedFrom(record, "useStore", "vuex")
    ) {
      push(
        { type: "reads", from: comp.id, to: "vuex:root", via: "hook" },
        "reads|vuex:root|hook",
      );
      return;
    }

    // Vuex map helpers in option spreads → same mapping, namespace-string attr.
    if (
      node.type === "SpreadElement" &&
      node.argument.type === "CallExpression" &&
      node.argument.callee.type === "Identifier"
    ) {
      const spec = VUEX_MAP_HELPER_EDGES[node.argument.callee.name];
      if (!spec) return;
      if (!importedFrom(record, node.argument.callee.name, "vuex")) return;
      const arg0 = node.argument.arguments[0];
      const segment =
        arg0?.type === "Literal" && typeof arg0.value === "string"
          ? vuexNamespaceSegment(arg0.value)
          : null;
      const target = vuexTargetId(segment, moduleNames);
      emitMapHelperEdges(target, spec, comp.id, push);
    }
  });
}

/** Map a setup() return object to template-visible name → StateId. Only the
 * returned bindings are reachable from the template. */
function buildSetupReturnMap(
  setupFn: FunctionLike,
  maps: VueReactiveMaps,
): Map<string, StateId> {
  const out = new Map<string, StateId>();
  const ret = optionsFnReturnObject(setupFn);
  if (!ret) return out;
  for (const p of ret.properties) {
    if (p.type !== "Property") continue;
    const templateName = propKeyName(p);
    if (!templateName) continue;
    const localName =
      p.value.type === "Identifier" ? p.value.name : templateName;
    const id = lookupVueBinding(maps, localName);
    if (id) out.set(templateName, id);
  }
  return out;
}

/**
 * Analyze an Options API SFC into the same graph the setup path produces:
 * data() → local sources, computed → derived sources, props → VuePropsInfo,
 * inject/provide → Vue-context edges, `this.x` reads/writes, lifecycle-fed
 * server caches, watch-derived state, local mixins merged in, a setup() option
 * analyzed with the script-setup machinery, and pinia map helpers. Vuex usage
 * is handled separately (analyzeVuexUsage). Returns false (→ counted
 * unresolved) only for shapes we can't model soundly: an unresolvable mixin, an
 * `extends`, or an unrecognized export.
 */
function analyzeVueOptionsComponent(
  comp: VueComponentInfo,
  record: FileRecord,
  records: Map<string, FileRecord>,
  parents: ParentMap,
  sources: Map<StateId, StateSource>,
  edges: Edge[],
  injectDecls: InjectDecls,
  vuePropPasses: VuePropPass[],
): boolean {
  const isVueName = vueNameResolver(record, comp.program);
  const obj = findOptionsObject(comp.program, isVueName);
  if (!obj) return false;

  // extends composes in a base options object we don't merge — leave unresolved.
  if (optionProp(obj, "extends")) return false;

  // Resolve mixins to in-set option objects. An unresolvable mixin (package
  // import, non-literal) — or one that itself composes further (nested
  // mixins/extends/setup we'd have to recurse into) — keeps the whole component
  // unresolved: its state would flow in invisibly.
  const mixinObjs: TSESTree.ObjectExpression[] = [];
  const mixinsProp = optionProp(obj, "mixins");
  if (mixinsProp) {
    if (mixinsProp.value.type !== "ArrayExpression") return false;
    for (const el of mixinsProp.value.elements) {
      if (el?.type !== "Identifier") return false;
      const resolved = resolveObjectExpression(record, el.name, records);
      if (!resolved) return false;
      if (
        optionProp(resolved, "mixins") ||
        optionProp(resolved, "extends") ||
        optionProp(resolved, "setup")
      )
        return false;
      mixinObjs.push(resolved);
    }
  }

  const seen = new Set<string>();
  const push = (edge: Edge, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  // Effective option objects — mixins first, the component last so its data/
  // computed/props win name collisions (Vue's merge precedence).
  const objs = [...mixinObjs, obj];

  const dataNames = new Map<string, StateId>();
  const computedNames = new Map<string, StateId>();

  const declareSource = (
    name: string,
    node: TSESTree.Node,
    kind: "options-data" | "computed",
    classification: StateClass,
  ): StateId => {
    const stateId: StateId = `${comp.file}#${comp.name}.${name}`;
    sources.set(stateId, {
      id: stateId,
      kind,
      classification,
      name,
      loc: toLoc(comp.file, node),
      ownerComponentId: comp.id,
    });
    edges.push({ type: "declares", from: comp.id, to: stateId });
    return stateId;
  };

  // data() → one local source per returned property, across all option objects.
  for (const o of objs) {
    const dataProp = optionProp(o, "data");
    const dataObj = dataProp ? optionsFnReturnObject(dataProp.value) : null;
    if (!dataObj) continue;
    for (const p of dataObj.properties) {
      if (p.type === "Property" && p.key.type === "Identifier")
        dataNames.set(
          p.key.name,
          declareSource(p.key.name, p, "options-data", "local"),
        );
    }
  }

  // computed → derived source per entry (function AND get/set object forms).
  for (const o of objs) {
    const computedProp = optionProp(o, "computed");
    if (computedProp?.value.type !== "ObjectExpression") continue;
    for (const p of computedProp.value.properties) {
      if (p.type === "Property" && p.key.type === "Identifier")
        computedNames.set(
          p.key.name,
          declareSource(p.key.name, p, "computed", "derived"),
        );
    }
  }

  // props → VuePropsInfo.names (camelCase); array or object form.
  for (const o of objs) {
    const propsProp = optionProp(o, "props");
    if (!propsProp) continue;
    const v = propsProp.value;
    if (v.type === "ArrayExpression") {
      for (const el of v.elements) {
        if (el?.type === "Literal" && typeof el.value === "string")
          comp.props.names.add(camelize(el.value));
      }
    } else if (v.type === "ObjectExpression") {
      for (const p of v.properties) {
        const name = p.type === "Property" ? propKeyName(p) : null;
        if (name) comp.props.names.add(camelize(name));
      }
    }
  }

  // inject → consumes edges (+ register the source key), like the setup path.
  const registerInject = (
    key: { id: StateId; name: string },
    node: TSESTree.Node,
  ) => {
    if (!injectDecls.has(key.id))
      injectDecls.set(key.id, { name: key.name, loc: toLoc(comp.file, node) });
    push(
      { type: "consumes", from: comp.id, to: key.id, via: "context" },
      `consumes|${key.id}`,
    );
  };
  for (const o of objs) {
    const injectProp = optionProp(o, "inject");
    if (!injectProp) continue;
    const v = injectProp.value;
    if (v.type === "ArrayExpression") {
      for (const el of v.elements) {
        if (!el) continue;
        const key = injectKeyOf(record, el, records);
        if (key) registerInject(key, el);
      }
    } else if (v.type === "ObjectExpression") {
      for (const p of v.properties) {
        if (p.type !== "Property") continue;
        const key = optionsInjectObjectKey(record, p, records);
        if (key) registerInject(key, p);
      }
    }
  }

  // provide (object literal or a function returning one) → provides edges.
  for (const o of objs) {
    const provideProp = optionProp(o, "provide");
    if (!provideProp) continue;
    const provObj =
      provideProp.value.type === "ObjectExpression"
        ? provideProp.value
        : optionsFnReturnObject(provideProp.value);
    if (!provObj) continue;
    for (const p of provObj.properties) {
      if (p.type !== "Property") continue;
      const key = optionsProvideKey(record, p, records);
      if (!key) continue;
      if (!injectDecls.has(key.id))
        injectDecls.set(key.id, { name: key.name, loc: toLoc(comp.file, p) });
      push(
        { type: "provides", from: comp.id, to: key.id },
        `provides|${key.id}`,
      );
    }
  }

  // Script reads/writes: `this.x` value position = read (hook); `this.x = …`,
  // `this.x++`, compound assignment = write (mutate). Props resolve to no
  // source, so `this.propName` produces no edge (handled by prop-drilling).
  for (const o of objs) {
    walk(o, (node) => {
      if (node.type === "AssignmentExpression") {
        const name = thisMemberName(node.left);
        const stateId = name
          ? (dataNames.get(name) ?? computedNames.get(name))
          : undefined;
        if (stateId)
          push(
            { type: "writes", from: comp.id, to: stateId, via: "mutate" },
            `writes|${stateId}`,
          );
        return;
      }
      if (node.type === "UpdateExpression") {
        const name = thisMemberName(node.argument);
        const stateId = name
          ? (dataNames.get(name) ?? computedNames.get(name))
          : undefined;
        if (stateId)
          push(
            { type: "writes", from: comp.id, to: stateId, via: "mutate" },
            `writes|${stateId}`,
          );
        return;
      }
      const readName = thisMemberName(node);
      if (!readName) return;
      const parent = parents.get(node);
      if (parent?.type === "AssignmentExpression" && parent.left === node)
        return;
      if (parent?.type === "UpdateExpression" && parent.argument === node)
        return;
      const stateId = dataNames.get(readName) ?? computedNames.get(readName);
      if (stateId)
        push(
          { type: "reads", from: comp.id, to: stateId, via: "hook" },
          `reads|${stateId}`,
        );
    });
  }

  // pinia map helpers in computed:/methods: spreads (component + mixins).
  for (const o of objs)
    analyzePiniaMapHelpers(o, record, records, comp.id, push);

  // setup() option — analyze its body with the script-setup machinery. Only its
  // RETURN object is template-visible; script-side reads/writes apply regardless.
  const setupProp = optionProp(obj, "setup");
  const setupFn = setupProp ? asFunction(setupProp.value) : null;
  const setupMaps = emptyVueReactiveMaps();
  let setupReturn = new Map<string, StateId>();
  if (setupFn) {
    declareVueReactiveSources(
      setupFn,
      comp,
      record,
      records,
      sources,
      edges,
      isVueName,
      setupMaps,
    );
    emitVueReactiveEdges(
      setupFn,
      comp,
      record,
      records,
      parents,
      injectDecls,
      isVueName,
      setupMaps,
      push,
    );
    setupReturn = buildSetupReturnMap(setupFn, setupMaps);
    // setup(props): the first param carries the props — record it so a declared
    // prop the setup reads counts as a real read (not a blind forward).
    const param0 = setupFn.params[0];
    if (param0?.type === "Identifier") {
      if (comp.props.varName === null) comp.props.varName = param0.name;
    } else if (param0?.type === "ObjectPattern") {
      for (const p of param0.properties)
        if (p.type === "Property" && p.key.type === "Identifier")
          comp.props.destructured.add(p.key.name);
    }
  }

  // Unified template pass. setup-returned names shadow options data/computed
  // names (Vue precedence), so they overlay last in the lookup map.
  const templateUse = scanVueTemplate(comp);
  const templateMap = new Map<string, StateId>();
  for (const [n, id] of dataNames) templateMap.set(n, id);
  for (const [n, id] of computedNames) templateMap.set(n, id);
  for (const [n, id] of setupReturn) templateMap.set(n, id);
  for (const name of templateUse.reads) {
    const stateId = templateMap.get(name);
    if (!stateId) continue;
    push(
      { type: "reads", from: comp.id, to: stateId, via: "hook" },
      `reads|${stateId}`,
    );
  }
  vuePropPasses.push(...templateUse.propPasses);

  // Options-data reclassify: a template mutation softens/kills derived+server
  // classification — but only when the name isn't shadowed by a setup binding
  // (then the mutation targets the setup ref, not the data field).
  const optionsTemplateMutates =
    comp.templateAst !== null
      ? (name: string) =>
          templateUse.mutated.has(name) && !setupReturn.has(name)
      : (name: string) => templateMayMutate(comp.template, name);
  reclassifyVueOptionsFedState(
    comp,
    objs,
    dataNames,
    sources,
    parents,
    optionsTemplateMutates,
  );

  // Setup-ref reclassify (lifecycle/watch inside setup): the template mutation
  // guard maps returned template names back to the setup ref they alias.
  if (setupFn) {
    const mutatedSetupIds = new Set<StateId>();
    for (const name of templateUse.mutated) {
      const id = setupReturn.get(name);
      if (id) mutatedSetupIds.add(id);
    }
    const setupTemplateMutates =
      comp.templateAst !== null
        ? (name: string) => {
            const id = setupMaps.refNames.get(name);
            return id ? mutatedSetupIds.has(id) : false;
          }
        : (name: string) => templateMayMutate(comp.template, name);
    reclassifyVueFedState(
      comp,
      isVueName,
      setupMaps.refNames,
      setupMaps.reactiveNames,
      sources,
      parents,
      setupTemplateMutates,
    );
  }
  return true;
}

/**
 * Options-API mirror of reclassifyVueFedState. A data field assigned inside an
 * async lifecycle hook (fetch/axios/await) — directly or in a .then/.catch/
 * .finally continuation — is a hand-rolled server cache. A field a SYNC watch
 * handler assigns directly is derived state that should be a computed. Both
 * soften when the same field is also written elsewhere (methods, other hooks)
 * or mutated by the template.
 */
function reclassifyVueOptionsFedState(
  comp: VueComponentInfo,
  objs: TSESTree.ObjectExpression[],
  dataNames: Map<string, StateId>,
  sources: Map<StateId, StateSource>,
  parents: ParentMap,
  templateMutates: (name: string) => boolean,
): void {
  const feedFns = new Set<TSESTree.Node>();

  const hasAsyncMarker = (fn: FunctionLike): boolean => {
    let async = fn.async === true;
    walk(fn.body, (inner) => {
      if (inner.type === "AwaitExpression") async = true;
      if (
        inner.type === "Identifier" &&
        (inner.name === "fetch" || inner.name === "axios")
      )
        async = true;
    });
    return async;
  };

  // Lifecycle hooks: fetch-fed data fields → server-cache. Both the component's
  // and any mixin's hooks feed (Vue runs mixin hooks before the component's).
  for (const obj of objs) {
    for (const p of obj.properties) {
      if (p.type !== "Property" || p.computed || p.key.type !== "Identifier")
        continue;
      if (!OPTIONS_LIFECYCLE_HOOKS.has(p.key.name)) continue;
      const fn = asFunction(p.value);
      if (!fn) continue;
      feedFns.add(fn);
      if (!hasAsyncMarker(fn)) continue;
      const hookLoc = toLoc(comp.file, p);
      walk(fn.body, (inner) => {
        if (inner.type !== "AssignmentExpression") return;
        const name = thisMemberName(inner.left);
        const stateId = name ? dataNames.get(name) : undefined;
        if (!stateId) return;
        if (!withinFetchChain(inner, fn, parents)) return;
        const source = sources.get(stateId);
        if (!source) return;
        source.classification = "server-cache";
        source.serverFed ??= { effect: hookLoc, editedOutsideEffect: false };
      });
    }
  }

  // watch handlers: a sync handler that assigns `this.y` directly derives y.
  for (const obj of objs) {
    const watchProp = optionProp(obj, "watch");
    if (watchProp?.value.type !== "ObjectExpression") continue;
    for (const w of watchProp.value.properties) {
      if (w.type !== "Property") continue;
      let handler = asFunction(w.value);
      if (!handler && w.value.type === "ObjectExpression") {
        const h = optionProp(w.value, "handler");
        handler = h ? asFunction(h.value) : null;
      }
      if (!handler) continue;
      feedFns.add(handler);
      if (hasAsyncMarker(handler)) continue;
      const handlerLoc = toLoc(comp.file, w);
      walk(handler.body, (inner) => {
        if (inner.type !== "AssignmentExpression") return;
        const name = thisMemberName(inner.left);
        const stateId = name ? dataNames.get(name) : undefined;
        if (!stateId) return;
        if (nestedInFunction(inner, handler, parents)) return;
        const source = sources.get(stateId);
        if (!source || source.serverFed) return;
        source.derivedSync ??= {
          effect: handlerLoc,
          editedOutsideEffect: false,
        };
      });
    }
  }

  if (feedFns.size === 0) return;

  // A `this.x` write outside every feeding hook/handler means other code owns
  // this field too — a prefilled draft (server-fed) or a hard disqualifier
  // (derived). Assignments and updates both count.
  for (const obj of objs) {
    walk(obj, (node) => {
      let name: string | null = null;
      if (node.type === "AssignmentExpression")
        name = thisMemberName(node.left);
      else if (node.type === "UpdateExpression")
        name = thisMemberName(node.argument);
      if (!name) return;
      const stateId = dataNames.get(name);
      if (!stateId) return;
      const source = sources.get(stateId);
      if (!source?.serverFed && !source?.derivedSync) return;
      let cursor: TSESTree.Node | undefined = node;
      while (cursor) {
        if (feedFns.has(cursor)) return; // inside a feeder — the feed itself
        cursor = parents.get(cursor);
      }
      if (source.serverFed) source.serverFed.editedOutsideEffect = true;
      if (source.derivedSync) source.derivedSync.editedOutsideEffect = true;
    });
  }

  // Template writes soften both; finalize purely-derived fields to 'derived'.
  for (const stateId of dataNames.values()) {
    const source = sources.get(stateId);
    if (!source) continue;
    if (templateMutates(source.name)) {
      if (source.serverFed) source.serverFed.editedOutsideEffect = true;
      if (source.derivedSync) source.derivedSync.editedOutsideEffect = true;
    }
    if (source.derivedSync && !source.derivedSync.editedOutsideEffect)
      source.classification = "derived";
  }
}

// ─── Per-component analysis ───

const HOOK_KINDS = { useState: "useState", useReducer: "useReducer" } as const;

function classify(kind: keyof typeof HOOK_KINDS): StateClass {
  // v1: local hooks default to 'local'. Detector #1 (server-state-in-client-state)
  // will reclassify fetch-fed sources to 'server-cache' when the classifier lands.
  void kind;
  return "local";
}

function analyzeComponent(
  comp: ComponentInfo,
  parents: ParentMap,
  sources: Map<StateId, StateSource>,
  edges: Edge[],
  propPasses: PropPass[],
): void {
  const valueBindings = new Map<string, StateId>();
  const setterBindings = new Map<string, StateId>();

  // Pass 1: find useState/useReducer declarations.
  walk(comp.fn, (node) => {
    if (node.type !== "VariableDeclarator") return;
    if (node.init?.type !== "CallExpression") return;
    const callee = node.init.callee;
    if (callee.type !== "Identifier") return;
    const kind = HOOK_KINDS[callee.name as keyof typeof HOOK_KINDS];
    if (!kind || node.id.type !== "ArrayPattern") return;

    const [valueEl, setterEl] = node.id.elements;
    if (valueEl?.type !== "Identifier") return;
    const stateId: StateId = `${comp.file}#${comp.name}.${valueEl.name}`;
    sources.set(stateId, {
      id: stateId,
      kind,
      classification: classify(callee.name as keyof typeof HOOK_KINDS),
      name: valueEl.name,
      loc: toLoc(comp.file, node),
      ownerComponentId: comp.id,
    });
    edges.push({ type: "declares", from: comp.id, to: stateId });
    valueBindings.set(valueEl.name, stateId);
    if (setterEl?.type === "Identifier")
      setterBindings.set(setterEl.name, stateId);
  });

  if (valueBindings.size === 0 && setterBindings.size === 0) {
    collectPropPasses(comp, propPasses);
    return;
  }

  // Pass 2: reads (value referenced) and writes (setter called).
  const seen = new Set<string>();
  walk(comp.fn, (node) => {
    if (node.type !== "Identifier") return;
    const parent = parents.get(node);
    if (isNonValuePosition(node, parent)) return;

    const writeTarget = setterBindings.get(node.name);
    if (
      writeTarget &&
      parent?.type === "CallExpression" &&
      parent.callee === node
    ) {
      const key = `writes|${writeTarget}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push({
          type: "writes",
          from: comp.id,
          to: writeTarget,
          via: "setter",
        });
      }
      return;
    }

    const readTarget = valueBindings.get(node.name);
    if (readTarget) {
      const key = `reads|${readTarget}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push({
          type: "reads",
          from: comp.id,
          to: readTarget,
          via: "hook",
        });
      }
    }
  });

  // Pass 3: state fed from async effects is a server cache living client-side.
  reclassifyServerFedState(comp, setterBindings, sources, parents);

  collectPropPasses(comp, propPasses);
}

/**
 * useState/useReducer whose setter is called inside a useEffect doing async
 * work (fetch/await/axios) is caching server data in client state — the
 * classifier upgrade that powers the server-state-in-client-state detector.
 *
 * Each fed source records WHICH effect fed it (findings group per effect, not
 * per field) and whether its setter is also called outside the effect — that's
 * a prefilled, user-edited draft, which reads differently than a pure cache.
 */
function reclassifyServerFedState(
  comp: ComponentInfo,
  setterBindings: Map<string, StateId>,
  sources: Map<StateId, StateSource>,
  parents: ParentMap,
): void {
  const effectCallbacks = new Set<TSESTree.Node>();

  walk(comp.fn, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee.type !== "Identifier" || node.callee.name !== "useEffect")
      return;
    const callback = asFunction(node.arguments[0]);
    if (!callback) return;
    effectCallbacks.add(callback);

    let asyncWork = false;
    const fedStateIds = new Set<StateId>();
    const fedDirect = new Set<StateId>();
    const fedNested = new Set<StateId>();
    walk(callback.body, (inner) => {
      if (inner.type === "AwaitExpression") asyncWork = true;
      if (inner.type !== "Identifier") return;
      // Any reference counts: setX(...) calls AND point-free .then(setX).
      if (inner.name === "fetch" || inner.name === "axios") asyncWork = true;
      const stateId = setterBindings.get(inner.name);
      if (!stateId) return;
      fedStateIds.add(stateId);
      // Direct = referenced with the effect callback as the nearest enclosing
      // function. Anything nested (setInterval ticks, subscription handlers,
      // callback-API results like Google Places) is event/async-driven —
      // that's not derivation, even without await/fetch in sight.
      let nested = false;
      let cursor: TSESTree.Node | undefined = parents.get(inner);
      while (cursor && cursor !== callback) {
        if (
          cursor.type === "ArrowFunctionExpression" ||
          cursor.type === "FunctionExpression" ||
          cursor.type === "FunctionDeclaration"
        ) {
          nested = true;
          break;
        }
        cursor = parents.get(cursor);
      }
      if (nested) {
        fedNested.add(stateId);
        return;
      }
      const call = parents.get(inner);
      if (call?.type === "CallExpression" && call.callee === inner) {
        // Updater form setX(prev => …) is an accumulator — self-referential
        // state (counters, toggles) is not a pure function of other state.
        if (asFunction(call.arguments[0])) {
          fedNested.add(stateId);
          return;
        }
        fedDirect.add(stateId);
      }
    });

    const effectLoc = toLoc(comp.file, node);
    if (asyncWork) {
      for (const stateId of fedStateIds) {
        const source = sources.get(stateId);
        if (!source) continue;
        source.classification = "server-cache";
        // First feeding effect wins as the grouping anchor.
        source.serverFed ??= { effect: effectLoc, editedOutsideEffect: false };
      }
      return;
    }

    // Sync effect feeding state ONLY at the top level = derived candidate.
    // A setter that also fires inside any nested callback is event-driven.
    for (const stateId of fedDirect) {
      if (fedNested.has(stateId)) continue;
      const source = sources.get(stateId);
      if (!source || source.serverFed) continue;
      source.derivedSync ??= { effect: effectLoc, editedOutsideEffect: false };
    }
  });

  if (effectCallbacks.size === 0) return;

  // Edited-outside detection: a fed setter CALLED outside every effect
  // callback — or merely REFERENCED outside one (passed as a prop, wrapped in
  // another function, handed to a hook) — means other logic writes this state
  // too. That's a prefilled draft for server-fed state and a hard
  // disqualifier for derived state. (Solstice dogfood: setAppData passed to
  // providers made 'appData' look derived when it's app-wide mutable state.)
  walk(comp.fn, (node) => {
    if (node.type !== "Identifier") return;
    const stateId = setterBindings.get(node.name);
    if (!stateId) return;
    const source = sources.get(stateId);
    if (!source?.serverFed && !source?.derivedSync) return;
    if (isNonValuePosition(node, parents.get(node))) return; // its own binding

    let cursor: TSESTree.Node | undefined = node;
    while (cursor && cursor !== comp.fn) {
      if (effectCallbacks.has(cursor)) return; // inside an effect — the feed itself
      cursor = parents.get(cursor);
    }
    if (source.serverFed) source.serverFed.editedOutsideEffect = true;
    if (source.derivedSync) source.derivedSync.editedOutsideEffect = true;
  });

  // Finalize: purely-derived state gets the 'derived' classification.
  for (const stateId of setterBindings.values()) {
    const source = sources.get(stateId);
    if (source?.derivedSync && !source.derivedSync.editedOutsideEffect) {
      source.classification = "derived";
    }
  }
}

/** Inline literals create a new reference every render — the memo defeater. */
function isInlineRefLiteral(node: TSESTree.Node): boolean {
  return (
    node.type === "ObjectExpression" ||
    node.type === "ArrayExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  );
}

/** Structurally broken useMemo/useCallback: provable at the AST, no runtime needed. */
function scanMemoIssues(
  fn: FunctionLike,
  ownerId: string,
  file: string,
  out: MemoIssue[],
): void {
  walk(fn, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier")
      return;
    const kind = node.callee.name;
    if (kind !== "useMemo" && kind !== "useCallback") return;

    if (node.arguments.length < 2) {
      out.push({ kind, issue: "no-deps", ownerId, loc: toLoc(file, node) });
      return;
    }
    const deps = node.arguments[1];
    if (deps?.type !== "ArrayExpression") return; // spread/identifier deps — can't judge
    for (const dep of deps.elements) {
      if (dep && isInlineRefLiteral(dep)) {
        out.push({
          kind,
          issue: "unstable-dep",
          ownerId,
          loc: toLoc(file, dep),
        });
        return;
      }
    }
  });
}

/** Record `<Child foo={expr} />` observations for known-component children. */
function collectPropPasses(comp: ComponentInfo, propPasses: PropPass[]): void {
  walk(comp.fn, (node) => {
    if (node.type !== "JSXOpeningElement") return;
    if (node.name.type !== "JSXIdentifier" || !isCapitalized(node.name.name))
      return;
    for (const attr of node.attributes) {
      if (attr.type !== "JSXAttribute" || attr.name.type !== "JSXIdentifier")
        continue;
      if (attr.value?.type !== "JSXExpressionContainer") continue;
      propPasses.push({
        fromComponentId: comp.id,
        fromFile: comp.file,
        childName: node.name.name,
        prop: attr.name.name,
        inline: isInlineRefLiteral(attr.value.expression),
        loc: toLoc(comp.file, attr),
      });
    }
  });
}

// ─── Child prop-read analysis (drives passesProp.reads) ───

function componentReadsProp(
  child: ComponentInfo,
  prop: string,
  parents: ParentMap,
): boolean {
  const param = child.fn.params[0];
  if (!param) return false;

  // ({ user }) — find the local binding for the prop, then look for real uses.
  if (param.type === "ObjectPattern") {
    let localName: string | null = null;
    for (const property of param.properties) {
      if (
        property.type === "Property" &&
        property.key.type === "Identifier" &&
        property.key.name === prop &&
        property.value.type === "Identifier"
      ) {
        localName = property.value.name;
        break;
      }
    }
    if (!localName) return false;
    return hasNonForwardUse(child.fn.body, parents, (node) => {
      if (node.type !== "Identifier" || node.name !== localName) return null;
      if (isNonValuePosition(node, parents.get(node))) return null;
      return node;
    });
  }

  // (props) — look for props.user uses.
  if (param.type === "Identifier") {
    const propsName = param.name;
    return hasNonForwardUse(child.fn.body, parents, (node) => {
      if (node.type !== "MemberExpression" || node.computed) return null;
      if (node.object.type !== "Identifier" || node.object.name !== propsName)
        return null;
      if (node.property.type !== "Identifier" || node.property.name !== prop)
        return null;
      return node;
    });
  }

  return false;
}

/** True if `match` finds any occurrence that isn't a pure forward to another component. */
function hasNonForwardUse(
  body: TSESTree.Node,
  parents: ParentMap,
  match: (node: TSESTree.Node) => TSESTree.Node | null,
): boolean {
  let reads = false;
  walk(body, (node) => {
    if (reads) return;
    const occurrence = match(node);
    if (!occurrence) return;
    if (!isForwardToComponent(occurrence, parents)) reads = true;
  });
  return reads;
}

// ─── Graph assembly ───

function createGraph(
  components: Map<ComponentId, ComponentNode>,
  sources: Map<StateId, StateSource>,
  edges: Edge[],
  unresolved: { selectorReads: number; optionsComponents: number },
  memoIssues: MemoIssue[],
  frameworkHints: { nuxt: boolean },
): StateGraph {
  return {
    components,
    sources,
    edges,
    unresolved,
    memoIssues,
    frameworkHints,
    readsOf(id: StateId): Edge[] {
      return edges.filter(
        (e) => (e.type === "reads" || e.type === "consumes") && e.to === id,
      );
    },
    sourcesOf(klass: StateClass): StateSource[] {
      return [...sources.values()].filter((s) => s.classification === klass);
    },
    propChain(start: ComponentId, prop: string): Edge[] {
      const chain: Edge[] = [];
      const visited = new Set<ComponentId>([start]);
      const queue: ComponentId[] = [start];
      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) break;
        for (const edge of edges) {
          if (
            edge.type !== "passesProp" ||
            edge.from !== current ||
            edge.prop !== prop
          )
            continue;
          chain.push(edge);
          if (!visited.has(edge.to)) {
            visited.add(edge.to);
            queue.push(edge.to);
          }
        }
      }
      return chain;
    },
  };
}

// ─── Entry point ───

export interface BuildOptions {
  /** Called when a file fails to parse; the file is skipped. Default: rethrow. */
  onParseError?: (path: string, error: unknown) => void;
}

export function buildStateGraph(
  files: SourceFileInput[],
  options: BuildOptions = {},
): StateGraph {
  const records = new Map<string, FileRecord>();
  const parents: ParentMap = new WeakMap();

  for (const file of files) {
    const isVue = file.path.endsWith(".vue");
    let code = file.code;
    let template: string | null = null;
    let templateAst: TplNode | null = null;
    let scriptLine = 1;
    let vueSetup = true;
    if (isVue) {
      try {
        const script = extractVueScript(file.path, file.code);
        if (!script) continue; // template-only SFC — nothing stateful to analyze
        vueSetup = script.setup;
        code = script.code;
        template = script.template;
        templateAst = script.templateAst;
        scriptLine = script.scriptLine;
      } catch (error) {
        if (!options.onParseError) throw error;
        options.onParseError(file.path, error);
        continue;
      }
    }
    const jsx = !isVue && !file.path.endsWith(".ts");
    let ast: TSESTree.Program;
    try {
      ast = parse(code, { jsx, loc: true });
    } catch (error) {
      if (!options.onParseError) throw error;
      options.onParseError(file.path, error);
      continue;
    }
    walk(ast, () => {}, parents); // populate parent links once per file
    const record = collectFileRecord(ast, file.path);
    if (isVue) {
      const name = vueComponentName(file.path);
      record.vueComponent = {
        id: `${file.path}#${name}`,
        name,
        file: file.path,
        loc: { file: file.path, line: scriptLine, col: 0 },
        setup: vueSetup,
        program: ast,
        template,
        templateAst,
        props: collectVueProps(ast),
      };
    }
    records.set(normalize(file.path), record);
  }

  const sources = new Map<StateId, StateSource>();
  const edges: Edge[] = [];
  const propPasses: PropPass[] = [];
  const vuePropPasses: VuePropPass[] = [];
  // optionsComponents counts ONLY Options API SFCs we couldn't model
  // (mixins/extends/Vuex/pinia map helpers/unrecognized shape); it's
  // incremented in the analysis loop below, not at parse time.
  const unresolved = { selectorReads: 0, optionsComponents: 0 };
  const memoIssues: MemoIssue[] = [];

  // Register context + store sources. Both classify 'global-client' by
  // definition — they exist to share state across the tree.
  for (const record of records.values()) {
    for (const ctx of record.contexts.values()) {
      const stateId: StateId = `${record.path}#${ctx.name}`;
      sources.set(stateId, {
        id: stateId,
        kind: "context",
        classification: "global-client",
        name: ctx.name,
        loc: ctx.loc,
      });
    }
    for (const store of record.stores.values()) {
      const stateId: StateId = `${record.path}#${store.name}`;
      sources.set(stateId, {
        id: stateId,
        kind: "zustand",
        classification: "global-client",
        name: store.name,
        loc: store.loc,
        shape: store.fields
          ? { kind: "object", fields: store.fields }
          : undefined,
        fieldCount: store.fields?.length,
      });
    }
  }

  // Register Redux slices + RTK Query endpoints; identity is the slice/endpoint
  // name (store-global), so lookups during usage analysis are by name.
  const sliceIdsByName = new Map<string, StateId>();
  const endpointIdsByName = new Map<string, StateId>();
  for (const record of records.values()) {
    for (const slice of record.slices) {
      const stateId = sliceStateId(slice.sliceName);
      sliceIdsByName.set(slice.sliceName, stateId);
      sources.set(stateId, {
        id: stateId,
        kind: "redux-slice",
        classification: "global-client",
        name: slice.sliceName,
        loc: slice.loc,
        shape: slice.fields
          ? { kind: "object", fields: slice.fields }
          : undefined,
        fieldCount: slice.fields?.length,
      });
    }
    for (const [endpoint, loc] of record.rtkQueryEndpoints) {
      const stateId = rtkEndpointStateId(endpoint);
      endpointIdsByName.set(endpoint, stateId);
      sources.set(stateId, {
        id: stateId,
        kind: "rtk-query",
        classification: "server-cache",
        name: endpoint,
        loc,
      });
    }
    // Pinia stores — identity is the defineStore id (app-global singleton).
    for (const store of record.piniaStores.values()) {
      const stateId = piniaStateId(store.storeId);
      if (sources.has(stateId)) continue; // duplicate defineStore id — first wins
      sources.set(stateId, {
        id: stateId,
        kind: "pinia",
        classification: "global-client",
        name: store.storeId,
        loc: store.loc,
        shape: store.fields
          ? { kind: "object", fields: store.fields }
          : undefined,
        fieldCount: store.fields?.length,
      });
    }
  }

  // Vuex stores — one `vuex:root` (first createStore wins) plus `vuex:<module>`
  // per key of `modules: {…}`. Module names drive attribution during usage.
  const vuexModuleNames = new Set<string>();
  let hasVuexRoot = false;
  for (const record of records.values()) {
    for (const store of record.vuexStores) {
      if (!hasVuexRoot) {
        hasVuexRoot = true;
        const fields = store.config ? vuexStateFields(store.config) : undefined;
        sources.set("vuex:root", {
          id: "vuex:root",
          kind: "vuex",
          classification: "global-client",
          name: "root",
          loc: store.loc,
          shape: fields ? { kind: "object", fields } : undefined,
          fieldCount: fields?.length,
        });
      }
      const modulesProp = store.config
        ? optionProp(store.config, "modules")
        : null;
      if (modulesProp?.value.type !== "ObjectExpression") continue;
      for (const p of modulesProp.value.properties) {
        if (p.type !== "Property") continue;
        const name = propKeyName(p);
        if (!name) continue;
        vuexModuleNames.add(name);
        const modId: StateId = `vuex:${name}`;
        if (sources.has(modId)) continue;
        let modObj: TSESTree.ObjectExpression | null = null;
        if (p.value.type === "ObjectExpression") modObj = p.value;
        else if (p.value.type === "Identifier")
          modObj = resolveObjectExpression(record, p.value.name, records);
        const fields = modObj ? vuexStateFields(modObj) : undefined;
        sources.set(modId, {
          id: modId,
          kind: "vuex",
          classification: "global-client",
          name,
          loc: toLoc(record.path, p),
          shape: fields ? { kind: "object", fields } : undefined,
          fieldCount: fields?.length,
        });
      }
    }
  }

  const queryLocs = new Map<string, SourceLoc>();
  const storageLocs = new Map<StateId, SourceLoc>();
  const urlLocs = new Map<StateId, SourceLoc>();
  const cookieLocs = new Map<StateId, SourceLoc>();
  const injectDecls: InjectDecls = new Map();
  const hookUse = computeHookSharedUse(
    records,
    queryLocs,
    storageLocs,
    urlLocs,
    cookieLocs,
  );

  for (const record of records.values()) {
    for (const comp of record.components.values()) {
      analyzeComponent(comp, parents, sources, edges, propPasses);
      analyzeSharedStateUsage(
        comp,
        record,
        records,
        hookUse,
        queryLocs,
        storageLocs,
        urlLocs,
        cookieLocs,
        edges,
      );
      analyzeStoreUsage(comp, record, records, edges);
      analyzeReduxUsage(
        comp,
        record,
        edges,
        sliceIdsByName,
        endpointIdsByName,
        unresolved,
      );
      scanMemoIssues(comp.fn, comp.id, comp.file, memoIssues);
    }
    for (const hook of record.hooks.values()) {
      scanMemoIssues(hook.fn, hook.id, hook.file, memoIssues);
    }
    if (record.vueComponent) {
      const comp = record.vueComponent;
      if (comp.setup) {
        analyzeVueComponent(
          comp,
          record,
          records,
          parents,
          sources,
          edges,
          injectDecls,
          vuePropPasses,
        );
      } else if (
        !analyzeVueOptionsComponent(
          comp,
          record,
          records,
          parents,
          sources,
          edges,
          injectDecls,
          vuePropPasses,
        )
      ) {
        // Unmodeled Options shape (unresolvable mixin/extends/unrecognized
        // script shape) — its readers/consumers are invisible, so reader-count
        // claims are suppressed while this is nonzero.
        unresolved.optionsComponents++;
      }
      // Vuex usage (this.$store / map helpers / useStore) attributes onto the
      // registered vuex sources — script-setup and options alike.
      if (hasVuexRoot)
        analyzeVuexUsage(comp, record, parents, edges, vuexModuleNames);
      analyzeSharedStateUsage(
        { id: comp.id, name: comp.name, file: comp.file, fn: comp.program },
        record,
        records,
        hookUse,
        queryLocs,
        storageLocs,
        urlLocs,
        cookieLocs,
        edges,
      );
    }
  }

  // Register provide/inject sources — Vue's context. Global by definition.
  for (const [stateId, decl] of injectDecls) {
    sources.set(stateId, {
      id: stateId,
      kind: "provide-inject",
      classification: "global-client",
      name: decl.name,
      loc: decl.loc,
    });
  }

  // Register query sources — one per distinct key, identity is the key itself
  // (the TanStack cache is global; call sites share entries).
  for (const [key, loc] of queryLocs) {
    const stateId = queryStateId(key);
    sources.set(stateId, {
      id: stateId,
      kind: "tanstack-query",
      classification: "server-cache",
      name: key,
      loc,
    });
  }

  // Register storage sources — identity is `storage:<area>:<key>`; the key
  // name is the entity. Storage is global AND persistent, but not reactive.
  for (const [stateId, loc] of storageLocs) {
    const [, area, ...keyParts] = stateId.split(":");
    sources.set(stateId, {
      id: stateId,
      kind: area === "local" ? "local-storage" : "session-storage",
      classification: "global-client",
      name: keyParts.join(":"),
      loc,
    });
  }

  // Register URL param sources — the address bar is global, shareable state.
  for (const [stateId, loc] of urlLocs) {
    sources.set(stateId, {
      id: stateId,
      kind: "url-param",
      classification: "global-client",
      name: stateId.slice("url:".length),
      loc,
    });
  }

  // Register cookie sources — identity is the cookie name; global and
  // persistent like storage, shared with the server.
  for (const [stateId, loc] of cookieLocs) {
    sources.set(stateId, {
      id: stateId,
      kind: "cookie",
      classification: "global-client",
      name: stateId.slice("cookie:".length),
      loc,
    });
  }

  // Resolve prop passes into edges — local components first, then imports.
  for (const pass of propPasses) {
    const from = records.get(normalize(pass.fromFile));
    if (!from) continue;
    const child = resolveComponent(from, pass.childName, records);
    if (!child) continue; // not in the analyzed file set (package import, dynamic, …)
    edges.push({
      type: "passesProp",
      from: pass.fromComponentId,
      to: child.id,
      prop: pass.prop,
      reads: componentReadsProp(child, pass.prop, parents),
      inline: pass.inline,
      loc: pass.loc,
    });
  }

  // Vue template prop passes — same edge, SFC-resolved.
  for (const pass of vuePropPasses) {
    const from = records.get(normalize(pass.fromFile));
    if (!from) continue;
    const child = resolveVueComponentByTag(from, pass.childTag, records);
    if (!child) continue; // package component, dynamic, or ambiguous auto-import
    edges.push({
      type: "passesProp",
      from: pass.fromComponentId,
      to: child.id,
      prop: pass.prop,
      reads: vueChildReadsProp(child, pass.prop),
      inline: pass.inline,
      loc: pass.loc,
    });
  }

  const componentNodes = new Map<ComponentId, ComponentNode>();
  for (const record of records.values()) {
    for (const comp of record.components.values()) {
      componentNodes.set(comp.id, {
        id: comp.id,
        name: comp.name,
        loc: comp.loc,
        isMemo: comp.isMemo,
      });
    }
    if (record.vueComponent) {
      const comp = record.vueComponent;
      componentNodes.set(comp.id, {
        id: comp.id,
        name: comp.name,
        loc: comp.loc,
        isMemo: false,
      });
    }
  }

  // Nuxt is detected from its own composables being called without a
  // non-Nuxt import claiming the name — the auto-import signature.
  let nuxt = false;
  for (const record of records.values()) {
    for (const marker of record.nuxtMarkerCalls) {
      const source = record.imports.get(marker)?.source;
      if (
        source === undefined ||
        source === "#app" ||
        source === "#imports" ||
        source.startsWith("nuxt")
      ) {
        nuxt = true;
        break;
      }
    }
    if (nuxt) break;
  }

  return createGraph(componentNodes, sources, edges, unresolved, memoIssues, {
    nuxt,
  });
}
