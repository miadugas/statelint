/**
 * Graph builder — parses source files and populates the StateGraph.
 *
 * v1 scope: function components, useState/useReducer sources, and the
 * declares / reads / writes / passesProp edges. Context/Redux/Zustand/Query
 * adapters layer in later; each adds sources + edges, never new detector
 * logic (detectors only ever query the graph).
 */

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
  childName: string;
  prop: string;
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

// ─── Component collection ───

function collectComponents(
  ast: TSESTree.Program,
  file: string,
  out: Map<string, ComponentInfo>,
): void {
  walk(ast, (node) => {
    if (
      node.type === "FunctionDeclaration" &&
      node.id &&
      isCapitalized(node.id.name)
    ) {
      const name = node.id.name;
      out.set(name, {
        id: `${file}#${name}`,
        name,
        file,
        loc: toLoc(file, node),
        isMemo: false,
        fn: node,
      });
      return;
    }
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      const name = node.id.name;
      if (!isCapitalized(name) || !node.init) return;
      const direct = asFunction(node.init);
      const memoized = direct ? null : unwrapMemo(node.init);
      const fn = direct ?? memoized;
      if (!fn) return;
      out.set(name, {
        id: `${file}#${name}`,
        name,
        file,
        loc: toLoc(file, node),
        isMemo: memoized !== null,
        fn,
      });
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
  reclassifyServerFedState(comp, setterBindings, sources);

  collectPropPasses(comp, propPasses);
}

/**
 * useState/useReducer whose setter is called inside a useEffect doing async
 * work (fetch/await/axios) is caching server data in client state — the
 * classifier upgrade that powers the server-state-in-client-state detector.
 */
function reclassifyServerFedState(
  comp: ComponentInfo,
  setterBindings: Map<string, StateId>,
  sources: Map<StateId, StateSource>,
): void {
  walk(comp.fn, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee.type !== "Identifier" || node.callee.name !== "useEffect")
      return;
    const callback = asFunction(node.arguments[0]);
    if (!callback) return;

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
    for (const stateId of fedStateIds) {
      const source = sources.get(stateId);
      if (source) source.classification = "server-cache";
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
): StateGraph {
  return {
    components,
    sources,
    edges,
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

export function buildStateGraph(files: SourceFileInput[]): StateGraph {
  const componentsByName = new Map<string, ComponentInfo>();
  const parents: ParentMap = new WeakMap();
  const asts: TSESTree.Program[] = [];

  for (const file of files) {
    const jsx = !file.path.endsWith(".ts");
    const ast = parse(file.code, { jsx, loc: true });
    asts.push(ast);
    walk(ast, () => {}, parents); // populate parent links once per file
    collectComponents(ast, file.path, componentsByName);
  }

  const sources = new Map<StateId, StateSource>();
  const edges: Edge[] = [];
  const propPasses: PropPass[] = [];

  for (const comp of componentsByName.values()) {
    analyzeComponent(comp, parents, sources, edges, propPasses);
  }

  // Resolve prop passes into edges, computing whether the child truly reads the prop.
  for (const pass of propPasses) {
    const child = componentsByName.get(pass.childName);
    if (!child) continue; // unknown/imported component — cross-file resolution is v2
    edges.push({
      type: "passesProp",
      from: pass.fromComponentId,
      to: child.id,
      prop: pass.prop,
      reads: componentReadsProp(child, pass.prop, parents),
    });
  }

  const componentNodes = new Map<ComponentId, ComponentNode>();
  for (const comp of componentsByName.values()) {
    componentNodes.set(comp.id, {
      id: comp.id,
      name: comp.name,
      loc: comp.loc,
      isMemo: comp.isMemo,
    });
  }

  return createGraph(componentNodes, sources, edges);
}
