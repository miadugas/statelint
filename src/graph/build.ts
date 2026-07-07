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
  SourceLoc,
  StateClass,
  StateGraph,
  StateId,
  StateSource,
} from "./schema.js";

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

/** Everything statelint knows about one parsed file. */
interface FileRecord {
  path: string;
  components: Map<string, ComponentInfo>;
  contexts: Map<string, ContextDecl>;
  stores: Map<string, StoreDecl>;
  slices: SliceDecl[];
  rtkQueryEndpoints: Map<string, SourceLoc>; // endpoint name → declaration site
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
    components: new Map(),
    contexts: new Map(),
    stores: new Map(),
    slices: [],
    rtkQueryEndpoints: new Map(),
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
  "/index.tsx",
  "/index.ts",
  "/index.jsx",
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
  fn: FunctionLike,
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

// ─── Shared-state usage (contexts, queries, storage, URL — direct or through hooks) ───

/** What a function body touches: contexts, query keys, storage keys, URL params, hooks. */
interface SharedUse {
  ctxIds: Set<StateId>;
  queryKeys: Set<string>;
  storageReads: Set<StateId>;
  storageWrites: Set<StateId>;
  urlReads: Set<StateId>;
  urlWrites: Set<StateId>;
  /** useState vars initialized FROM a url read: the fork pattern. */
  urlForks: Array<{ stateName: string; urlId: StateId }>;
  hookIds: Set<string>;
}

function scanSharedUse(
  fn: FunctionLike,
  from: FileRecord,
  records: Map<string, FileRecord>,
  queryLocs: Map<string, SourceLoc>,
  storageLocs: Map<StateId, SourceLoc>,
  urlLocs: Map<StateId, SourceLoc>,
): SharedUse {
  const use: SharedUse = {
    ctxIds: new Set(),
    queryKeys: new Set(),
    storageReads: new Set(),
    storageWrites: new Set(),
    urlReads: new Set(),
    urlWrites: new Set(),
    urlForks: [],
    hookIds: new Set(),
  };
  const urlBindings = collectUrlBindings(fn, from, use, urlLocs);

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

    if (node.type !== "CallExpression") return;

    const storage = storageAccessOf(node);
    if (storage) {
      if (storage.access === "read") use.storageReads.add(storage.id);
      else use.storageWrites.add(storage.id);
      if (!storageLocs.has(storage.id))
        storageLocs.set(storage.id, toLoc(from.path, node));
      return;
    }

    // sp.get('tab') on a searchParams binding
    const urlKey = urlReadKeyOf(node, urlBindings);
    if (urlKey) {
      markUrlRead(urlKey, node);
      return;
    }

    if (node.callee.type !== "Identifier") return;
    const calleeName = node.callee.name;

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
      }
    }
  }
  return uses;
}

/** Emit consumes/reads/provides edges for a component's shared-state usage. */
function analyzeSharedStateUsage(
  comp: ComponentInfo,
  from: FileRecord,
  records: Map<string, FileRecord>,
  hookUse: Map<string, SharedUse>,
  queryLocs: Map<string, SourceLoc>,
  storageLocs: Map<StateId, SourceLoc>,
  urlLocs: Map<StateId, SourceLoc>,
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
  // The fork pattern becomes a derivesFrom edge: useState var ← url param.
  for (const fork of use.urlForks) {
    const stateId: StateId = `${comp.file}#${comp.name}.${fork.stateName}`;
    push(
      { type: "derivesFrom", from: stateId, to: fork.urlId },
      `derivesFrom|${stateId}|${fork.urlId}`,
    );
  }

  walk(comp.fn, (node) => {
    if (node.type !== "JSXOpeningElement") return;

    // <Ctx.Provider value={...}>
    if (
      node.name.type === "JSXMemberExpression" &&
      node.name.object.type === "JSXIdentifier" &&
      node.name.property.name === "Provider"
    ) {
      const ctxId = resolveContext(from, node.name.object.name, records);
      if (ctxId)
        push(
          { type: "provides", from: comp.id, to: ctxId },
          `provides|${ctxId}`,
        );
      return;
    }

    // React 19: <Ctx value={...}> — a bare context element used as provider.
    if (node.name.type === "JSXIdentifier") {
      const ctxId = resolveContext(from, node.name.name, records);
      if (ctxId)
        push(
          { type: "provides", from: comp.id, to: ctxId },
          `provides|${ctxId}`,
        );
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
    walk(callback.body, (inner) => {
      if (inner.type === "AwaitExpression") asyncWork = true;
      if (inner.type !== "Identifier") return;
      // Any reference counts: setX(...) calls AND point-free .then(setX).
      if (inner.name === "fetch" || inner.name === "axios") asyncWork = true;
      const stateId = setterBindings.get(inner.name);
      if (stateId) fedStateIds.add(stateId);
    });

    if (!asyncWork) return;
    const effectLoc = toLoc(comp.file, node);
    for (const stateId of fedStateIds) {
      const source = sources.get(stateId);
      if (!source) continue;
      source.classification = "server-cache";
      // First feeding effect wins as the grouping anchor.
      source.serverFed ??= { effect: effectLoc, editedOutsideEffect: false };
    }
  });

  if (effectCallbacks.size === 0) return;

  // Draft detection: a fed setter called OUTSIDE every effect callback means
  // the user edits this state too (onChange etc.) — prefilled form draft.
  walk(comp.fn, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier")
      return;
    const stateId = setterBindings.get(node.callee.name);
    if (!stateId) return;
    const source = sources.get(stateId);
    if (!source?.serverFed) return;

    let cursor: TSESTree.Node | undefined = node;
    while (cursor && cursor !== comp.fn) {
      if (effectCallbacks.has(cursor)) return; // inside an effect — not an edit
      cursor = parents.get(cursor);
    }
    source.serverFed.editedOutsideEffect = true;
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
  unresolved: { selectorReads: number },
): StateGraph {
  return {
    components,
    sources,
    edges,
    unresolved,
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
    const jsx = !file.path.endsWith(".ts");
    let ast: TSESTree.Program;
    try {
      ast = parse(file.code, { jsx, loc: true });
    } catch (error) {
      if (!options.onParseError) throw error;
      options.onParseError(file.path, error);
      continue;
    }
    walk(ast, () => {}, parents); // populate parent links once per file
    records.set(normalize(file.path), collectFileRecord(ast, file.path));
  }

  const sources = new Map<StateId, StateSource>();
  const edges: Edge[] = [];
  const propPasses: PropPass[] = [];
  const unresolved = { selectorReads: 0 };

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
  }

  const queryLocs = new Map<string, SourceLoc>();
  const storageLocs = new Map<StateId, SourceLoc>();
  const urlLocs = new Map<StateId, SourceLoc>();
  const hookUse = computeHookSharedUse(
    records,
    queryLocs,
    storageLocs,
    urlLocs,
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
    }
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
  }

  return createGraph(componentNodes, sources, edges, unresolved);
}
