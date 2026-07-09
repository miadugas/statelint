/**
 * The State Graph — statelinter's core model.
 *
 * Every static detector is a pure query over this graph, never raw AST
 * spelunking. The graph is built once per analysis run from the source AST,
 * each state source is classified once, and detectors reuse both.
 */

// ─── Classification: the axis that makes this cross-library ───

/** Where a piece of state *should* conceptually live. */
export type StateClass =
  | "server-cache" // data owned by a server; the client holds a cache
  | "global-client" // app-wide UI / session state
  | "local" // belongs to a single component subtree
  | "derived" // a pure function of other state — shouldn't be stored at all
  | "unknown"; // could not classify; never auto-recommend on these

/** The concrete primitive/library a state source is expressed with. */
export type StateKind =
  | "useState"
  | "useReducer"
  | "context"
  | "zustand"
  | "redux-slice"
  | "rtk-query"
  | "tanstack-query"
  | "local-storage"
  | "session-storage"
  | "url-param"
  | "cookie"
  // Vue (SFC / script setup)
  | "ref"
  | "reactive"
  | "computed"
  | "pinia"
  | "provide-inject"
  // Vue (Vuex — createStore root + per-module)
  | "vuex"
  // Vue (SFC / Options API — data() fields)
  | "options-data";

// ─── Source locations ───

export interface SourceLoc {
  file: string;
  line: number;
  col: number;
}

export interface ValueShape {
  kind: "object" | "array" | "primitive" | "nonSerializable";
  /** Field names when the value is an object — used for monolithic-store + dup checks. */
  fields?: string[];
}

// ─── Node ids ───

export type ComponentId = string;
export type StateId = string;

// ─── Nodes ───

export interface StateSource {
  /** Stable id: file + symbol path (survives edits that don't move the symbol). */
  id: StateId;
  kind: StateKind;
  classification: StateClass;
  /** Human name: 'user', 'cartSlice', 'todosQuery'. */
  name: string;
  loc: SourceLoc;
  /** Component that declares it (local state) or mounts its provider (context/store). */
  ownerComponentId?: ComponentId;
  /** Structural type info (from TS) for size / duplication / monolith checks. */
  shape?: ValueShape;
  /** Field count, for monolithic-store detection. */
  fieldCount?: number;
  /** Set when an async effect feeds this source (server-state-in-client-state). */
  /** Set when a SYNC effect recomputes this state from other state/props —
   * the derived-state-as-state pattern. Only setter calls executing directly
   * in the effect body count (setInterval/subscription callbacks don't). */
  derivedSync?: {
    effect: SourceLoc;
    editedOutsideEffect: boolean;
  };
  serverFed?: {
    /** The useEffect call site — the grouping key for findings. */
    effect: SourceLoc;
    /** Setter also called outside the effect — a prefilled, user-edited draft. */
    editedOutsideEffect: boolean;
  };
}

export interface ComponentNode {
  id: ComponentId;
  name: string;
  loc: SourceLoc;
  /** Wrapped in React.memo. */
  isMemo: boolean;
}

// ─── Edges ───

export type ReadVia = "hook" | "selector" | "prop" | "context";
export type WriteVia = "setter" | "dispatch" | "mutate" | "setState";

export type Edge =
  /** Component owns/creates the source (local state, provider mount). */
  | { type: "declares"; from: ComponentId; to: StateId }
  /** Component reads the source during render. */
  | { type: "reads"; from: ComponentId; to: StateId; via: ReadVia }
  /** Component writes the source. */
  | { type: "writes"; from: ComponentId; to: StateId; via: WriteVia }
  /** Component passes a prop to a child. `reads` = whether the child actually
   * uses it; `inline` = the value was an inline object/array/function literal
   * (a new reference every render — what defeats React.memo). */
  | {
      type: "passesProp";
      from: ComponentId;
      to: ComponentId;
      prop: string;
      reads: boolean;
      inline?: boolean;
      loc?: SourceLoc;
    }
  /** Component mounts a Context/Store provider for the source. */
  | { type: "provides"; from: ComponentId; to: StateId }
  /** Component consumes a Context/Store source. */
  | { type: "consumes"; from: ComponentId; to: StateId; via: ReadVia }
  /** A source is computed from another source (derived-state dependency). */
  | { type: "derivesFrom"; from: StateId; to: StateId };

// ─── The graph ───

/** A structurally broken useMemo/useCallback the builder proved at the AST. */
export interface MemoIssue {
  kind: "useMemo" | "useCallback";
  issue: "no-deps" | "unstable-dep";
  ownerId: string; // component or hook id
  loc: SourceLoc;
}

export interface StateGraph {
  components: Map<ComponentId, ComponentNode>;
  sources: Map<StateId, StateSource>;
  edges: Edge[];

  /** Structurally broken memoization call sites (never "slow", only "broken"). */
  memoIssues: MemoIssue[];

  /**
   * Usage the builder saw but could not attribute — e.g. useSelector with an
   * imported named selector, or a Vue Options-API component we can't model
   * (unresolvable mixins/extends/unrecognized script shape). When nonzero,
   * detectors must not make "exactly N readers" claims over the affected
   * kinds; reads are undercounted.
   */
  unresolved: { selectorReads: number; optionsComponents: number };

  /** Framework signals observed while building — recommendations key on these
   * so a Nuxt app is pointed at useAsyncData, not a React query library. */
  frameworkHints: { nuxt: boolean };

  /** All edges that read a given source (any `via`). */
  readsOf(id: StateId): Edge[];
  /** All sources classified into a given bucket. */
  sourcesOf(klass: StateClass): StateSource[];
  /** Walk `passesProp` edges for `prop` starting at a component (for drill detection). */
  propChain(start: ComponentId, prop: string): Edge[];
}
