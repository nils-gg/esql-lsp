/**
 * tree-sitter integration (Phase 2).
 *
 * Lazily loads the `tree-sitter` runtime and the `tree-sitter-esql` grammar
 * and exposes parse-tree derived facts to the analyzer: modules, routines,
 * BROKER SCHEMA ids, declared names with their visibility scope, variable and
 * routine references, bare-SET targets, syntax errors and semantic tokens
 * (from the grammar's queries/highlights.scm).
 *
 * Graceful degradation is a hard requirement: if the native binding cannot
 * load (missing build toolchain, unsupported platform, npm install without
 * scripts), `grammarReady()` stays false and every caller falls back to the
 * Phase 1 regex heuristics. The server must never crash because of this
 * module. Setting `ESQL_LSP_NO_GRAMMAR=1` forces that fallback even when the
 * addon works — used by the heuristic-mode e2e test.
 */

import { Range } from 'vscode-languageserver';
import { linesOf } from './scanner';

/** Minimal structural view of a tree-sitter node (avoids pulling the
 *  runtime's types into the server's compile). */
export interface SyntaxNode {
  type: string;
  text: string;
  childCount: number;
  children: SyntaxNode[];
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  /** Byte offset range in the document (used to find the enclosing line). */
  startIndex: number;
  endIndex: number;
  /** Null only on the root; every damaged region has a parent to climb. */
  parent: SyntaxNode | null;
  hasError: boolean;
  isMissing?: boolean;
}

export interface Tree {
  rootNode: SyntaxNode;
}

/** What kind of name a declaration introduces. */
export type DeclKind = 'variable' | 'parameter';

export interface DeclaredName {
  name: string;
  /** Human-readable type for completion details, e.g. 'INTEGER'. */
  detail: string;
  /** Range of the declared name itself (definition target). */
  range: Range;
  kind: DeclKind;
  /** `DECLARE … CONSTANT` / `… CONSTANT` parameter. */
  constant: boolean;
  /**
   * `DECLARE x SHARED …` — visible to every flow of the application, so the
   * workspace index lets it satisfy the undeclared check in sibling files
   * (ISSUES.md I-13). Both extraction paths fill it; optional because
   * parameters never carry it and most callers ignore it.
   */
  shared?: boolean;
  /**
   * Range in which this declaration is visible: the enclosing routine body
   * for parameters and body-level DECLAREs, the enclosing module for
   * module-level DECLAREs, the whole file otherwise.
   */
  scope: Range;
}

export interface SetTarget {
  name: string;
  range: Range;
}

export interface SyntaxIssue {
  message: string;
  range: Range;
}

/** `CREATE (COMPUTE|FILTER|DATABASE|DATABASEEVENT) MODULE name … END MODULE`. */
export interface ModuleInfo {
  name: string;
  /** 'COMPUTE' | 'FILTER' | 'DATABASE' | 'DATABASEEVENT'. */
  kind: string;
  /** The whole `CREATE … END MODULE` statement. */
  range: Range;
  /** Just the module name (definition target / symbol selection range). */
  nameRange: Range;
}

/** `CREATE FUNCTION|PROCEDURE name (params) [RETURNS type] …`. */
export interface RoutineInfo {
  name: string;
  kind: 'FUNCTION' | 'PROCEDURE';
  /** Parameter list as written, comma-separated ('' when parameterless). */
  params: string;
  /** Uppercased return type, undefined for procedures / no RETURNS clause. */
  returnType?: string;
  /** Just the routine name (definition target / symbol selection range). */
  range: Range;
  /** The whole `CREATE … (END);` statement. */
  declRange: Range;
  /** `BEGIN … END` body; undefined for `EXTERNAL NAME` routines. */
  bodyRange?: Range;
  /** Enclosing module name, when the routine lives inside a module. */
  moduleName?: string;
}

/** `BROKER SCHEMA .mft.MySchema …`. */
export interface SchemaInfo {
  /** Schema id without its leading dot, e.g. 'mft.MySchema'. */
  name: string;
  range: Range;
}

/** One use of a variable or of a routine in the document. */
export interface Reference {
  /** Simple (last) name of the referenced symbol, case as written. */
  name: string;
  range: Range;
  /** A variable/parameter use, or a call of a user-defined routine. */
  kind: 'variable' | 'routine';
  /** Full dotted name for a schema-qualified `CALL a.b.c` target. */
  qualified?: string;
}

export interface DocAnalysis {
  declaredNames: DeclaredName[];
  setTargets: SetTarget[];
  syntaxIssues: SyntaxIssue[];
  modules: ModuleInfo[];
  routines: RoutineInfo[];
  schemas: SchemaInfo[];
  references: Reference[];
}

let runtimeParser: any = null;
let runtimeLanguage: any = null;
let highlightsQuery: any = null;
let initPromise: Promise<boolean> | null = null;

/**
 * TypeScript transpiles a literal `import()` to `require()` under
 * module:commonjs — and the grammar's Node binding is ESM with top-level
 * await, which `require()` cannot load. Building the import through
 * `new Function` keeps it a true dynamic import in the emitted CJS.
 */
const trueDynamicImport = new Function('s', 'return import(s)') as (
  specifier: string
) => Promise<any>;

/** Load the runtime + grammar once; resolves true when usable. */
export function initGrammar(): Promise<boolean> {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

/** Where the grammar module can be found. */
interface GrammarLocation {
  /** Dynamic-import specifier: a bare package name or an absolute file URL. */
  specifier: string;
  /** Directory that holds `queries/highlights.scm`. */
  dir: string;
}

/**
 * The grammar ships inside the published tarball (see scripts/prepack-grammar.js
 * — `tree-sitter-esql` is a `file:` dependency and does not exist on npm), in
 * addition to the plain package install used during development.
 */
function vendoredGrammarDir(): string {
  // dist/src/parser.js -> <package root>/vendor/tree-sitter-esql
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  return path.join(__dirname, '..', '..', 'vendor', 'tree-sitter-esql');
}

function locateGrammar(): GrammarLocation | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    return {
      specifier: 'tree-sitter-esql',
      dir: path.dirname(require.resolve('tree-sitter-esql/package.json')),
    };
  } catch {
    /* not installed as a package: fall through to the vendored copy */
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pathToFileURL } = require('url');
  const dir = vendoredGrammarDir();
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) return null;
  try {
    const main = JSON.parse(fs.readFileSync(manifest, 'utf8')).main ?? 'bindings/node/index.js';
    return { specifier: pathToFileURL(path.join(dir, main)).href, dir };
  } catch {
    return null;
  }
}

async function doInit(): Promise<boolean> {
  // Testing/debugging hook: force the heuristic path even when the native
  // addon is available (see the heuristic-mode e2e test).
  const forced = process.env['ESQL_LSP_NO_GRAMMAR'];
  if (forced === '1' || forced === 'true') {
    console.error('esql-lsp: ESQL_LSP_NO_GRAMMAR is set — heuristics only');
    return false;
  }
  try {
    // Lazy require inside try/catch: a broken native build must degrade,
    // not kill the server at import time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('tree-sitter');
    const ParserClass = mod.default ?? mod;

    const located = locateGrammar();
    if (!located) {
      throw new Error("cannot find 'tree-sitter-esql' (nor a vendored copy of it)");
    }
    const esql = await trueDynamicImport(located.specifier);
    runtimeLanguage = esql.default ?? esql;

    runtimeParser = new ParserClass();
    runtimeParser.setLanguage(runtimeLanguage);

    // Highlight queries live next to the grammar package.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const scm = fs.readFileSync(path.join(located.dir, 'queries', 'highlights.scm'), 'utf8');
    highlightsQuery = new ParserClass.Query(runtimeLanguage, scm);
    return true;
  } catch (err) {
    // stderr, never stdout (stdio carries the LSP protocol).
    console.error('esql-lsp: tree-sitter grammar unavailable, heuristics only:', String(err));
    runtimeParser = null;
    runtimeLanguage = null;
    highlightsQuery = null;
    return false;
  }
}

export function grammarReady(): boolean {
  return runtimeParser !== null && runtimeLanguage !== null;
}

/**
 * Parse a document; null when the grammar is unavailable or parsing fails.
 *
 * Lone `\r` is normalised to `\n` first. Every LSP client ends a line at a
 * lone `\r`, tree-sitter does not (it counts `\n` only), and without the
 * normalisation a CR-only file is ONE line to the parser: the outline collapses
 * and every position returned is meaningless (ISSUES.md I-19). The substitution
 * keeps the text the same length and only ever replaces a terminator character,
 * so each offset the tree reports still means what the client means at the same
 * offset — `\r\n` is left exactly as it was.
 */
export function parse(text: string): Tree | null {
  if (!grammarReady()) return null;
  const source = /\r(?!\n)/.test(text) ? text.replace(/\r(?!\n)/g, '\n') : text;
  try {
    return runtimeParser.parse(source) as Tree;
  } catch {
    return null;
  }
}

function rangeOf(node: SyntaxNode): Range {
  return Range.create(
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column
  );
}

/** Kinds accepted by `CREATE <kind> MODULE`. */
const MODULE_KINDS = ['COMPUTE', 'DATABASE', 'DATABASEEVENT', 'FILTER'];

/**
 * First child of `type`, from a child list the caller already read.
 *
 * Taking the array rather than the node is deliberate: `node.children` allocates
 * a new array of new `SyntaxNode` wrappers on every read (node-tree-sitter
 * 0.25.1), so a walk that looked up one field per node with this helper paid for
 * the whole child list twice (ISSUES.md I-20).
 */
function childOf(kids: readonly SyntaxNode[], type: string): SyntaxNode | undefined {
  return kids.find((c) => c.type === type);
}

/** `CREATE COMPUTE MODULE X` -> 'COMPUTE' (from the kw_* child). */
function moduleKind(kids: readonly SyntaxNode[]): string {
  for (const child of kids) {
    if (child.type.startsWith('kw_')) {
      const text = child.text.toUpperCase();
      if (MODULE_KINDS.includes(text)) return text;
    }
  }
  return 'COMPUTE';
}

/** Collapse a multi-line node's text into one detail string. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function moduleInfo(node: SyntaxNode, kids: readonly SyntaxNode[]): ModuleInfo | null {
  const nameNode = childOf(kids, 'identifier');
  if (!nameNode) return null;
  return {
    name: nameNode.text,
    kind: moduleKind(kids),
    range: rangeOf(node),
    nameRange: rangeOf(nameNode),
  };
}

function routineInfo(
  node: SyntaxNode,
  kids: readonly SyntaxNode[],
  moduleName?: string
): RoutineInfo | null {
  const nameNode = childOf(kids, 'identifier');
  if (!nameNode) return null;
  const isFunction = kids.some((c) => c.type === 'kw_FUNCTION');

  const params = kids
    .filter((c) => c.type === 'routine_parameter')
    .map((c) => oneLine(c.text))
    .join(', ');

  // RETURNS <datatype> [NULLABLE | NOT NULL] — the datatype right after the
  // keyword (the only datatype in that position; parameter datatypes live
  // inside routine_parameter children, not here).
  const returnsIndex = kids.findIndex((c) => c.type === 'kw_RETURNS');
  const returnNode =
    returnsIndex >= 0
      ? kids.slice(returnsIndex + 1).find((c) => c.type === 'datatype')
      : undefined;

  const body = childOf(kids, 'routine_body');
  return {
    name: nameNode.text,
    kind: isFunction ? 'FUNCTION' : 'PROCEDURE',
    params,
    returnType: returnNode ? oneLine(returnNode.text).toUpperCase() : undefined,
    range: rangeOf(nameNode),
    declRange: rangeOf(node),
    bodyRange: body ? rangeOf(body) : undefined,
    moduleName,
  };
}

/**
 * Extract everything the analyzers need from a parse tree in one walk:
 * modules, routines, BROKER SCHEMA ids, declared names (DECLARE name lists +
 * routine parameters, each with its visibility range), bare-word SET targets,
 * variable/routine references, and syntax errors (outermost ERROR regions
 * plus silently inserted tokens — see isInsertedNode).
 *
 * Scope tracking: `create_module_statement` opens a module scope (its own
 * range), `create_routine_statement` a routine scope (its BEGIN..END body, or
 * the whole CREATE statement when the body is an EXTERNAL NAME clause).
 */

/**
 * Tree-sitter's cheap error recovery repairs e.g. a missing `;` between
 * otherwise clean statements by INSERTING the token: it shows up as a
 * zero-width, empty-text leaf node typed after the expected token, without
 * any MISSING marker in the npm binding. Real nodes always have text, so
 * this pattern can only be an insertion.
 *
 * The width test comes first, and first matters: this runs for every node of
 * every walk, and `node.text` copies the node's whole span — asking for it on
 * nodes that are obviously not zero-width made the walk cost several times the
 * traversal itself (ISSUES.md I-20).
 */
function isInsertedNode(node: SyntaxNode): boolean {
  if (node.childCount !== 0) return false;
  // Zero width. Read through the native `startIndex`/`endIndex`, which the
  // bundled node-tree-sitter 0.25.1 typings omit: `node.text === ''` says the
  // same thing but copies the node's span, and this runs for every leaf.
  const { startIndex, endIndex } = node as unknown as {
    startIndex: number;
    endIndex: number;
  };
  return startIndex === endIndex;
}

/** Scope the walk is currently inside. */
interface WalkScope {
  /** Range declarations introduced here are visible in. */
  visible: Range;
  moduleName?: string;
  /** Set while walking inside this routine (parameters need its header). */
  routine?: RoutineInfo;
}

/**
 * Error recovery can swallow a whole `CREATE <KIND> MODULE name` header into an
 * ERROR node instead of keeping a `create_module_statement` — that is what
 * happens for the most common broken file of all: a module whose END MODULE is
 * still being typed. Recognise the sequence from the surviving tokens so the
 * module keeps showing up in the outline and stays navigable.
 */
function damagedModuleInfo(node: SyntaxNode): ModuleInfo | null {
  const children = node.children;
  for (let i = 1; i + 1 < children.length; i++) {
    if (children[i].type !== 'kw_MODULE') continue;
    const kind = children[i - 1].text.toUpperCase();
    // Rejects `END MODULE` (preceded by END) as well as foreign keywords.
    if (!MODULE_KINDS.includes(kind)) continue;
    const nameNode = children[i + 1];
    if (nameNode.type !== 'identifier') continue;
    return {
      name: nameNode.text,
      kind,
      range: rangeOf(node),
      nameRange: rangeOf(nameNode),
    };
  }
  return null;
}

/**
 * What the parser was waiting for, phrased the way a reader would say it.
 *
 * The binding reports an inserted token by its GRAMMAR token name, which for a
 * `field_reference` would print as `expected 'field_reference' here`, and — worse
 * — for a choice point names whichever alternative the DFA tried first, so a real
 * `DECLARE ns NAMESPACE '…'` produced `expected 'kw_BIT' here` (ISSUES.md I-12).
 * Punctuation is quoted as it stands; for a word-like token the construct it
 * belongs to says far more than the token, so use the parent node's type, and
 * keep the token name only when the construct says nothing.
 */
function expectedPhrase(tokenType: string, parentType?: string): string {
  // Punctuation is already the thing a reader would say (`expected ';' here`).
  if (!/[A-Za-z_]/.test(tokenType)) {
    return `Missing syntax: expected '${tokenType}' here.`;
  }
  const construct = parentType ? CONSTRUCT_LABELS[parentType] : undefined;
  if (construct) return `Missing syntax: expected ${construct} here.`;
  if (tokenType.startsWith('kw_')) {
    return `Missing syntax: expected '${tokenType.slice(3).toLowerCase()}' here.`;
  }
  return `Missing syntax: expected an ${tokenType.replace(/_/g, ' ')} here.`;
}

/**
 * Phrases naming the construct a damaged region belongs to, for the message
 * `Syntax error in <phrase>.` (ISSUES.md I-12: a bare `Syntax error.` over
 * six lines from the middle of a statement is not actionable — naming the
 * statement and pointing at its first line is). Derived from the node type
 * when one survived the error recovery; other `*_statement` types fall back
 * to a derived `A FOO BAR statement` phrase in `damagedPhraseFor`.
 */
const DAMAGED_CONSTRUCT_PHRASES: Record<string, string> = {
  set_statement: 'a SET statement',
  declare_statement: 'a DECLARE statement',
  declare_handler_statement: 'a DECLARE HANDLER',
  if_statement: 'an IF statement',
  while_statement: 'a WHILE loop',
  repeat_statement: 'a REPEAT loop',
  for_statement: 'a FOR loop',
  loop_statement: 'a LOOP block',
  case_statement: 'a CASE statement',
  call_statement: 'a CALL statement',
  return_statement: 'a RETURN statement',
  propagate_statement: 'a PROPAGATE statement',
  block_statement: 'a BEGIN block',
  create_module_statement: 'a module definition',
  create_routine_statement: 'a routine definition',
  broker_schema_statement: 'a BROKER SCHEMA statement',
  insert_statement: 'an INSERT statement',
  update_statement: 'an UPDATE statement',
  delete_from_statement: 'a DELETE statement',
  delete_field_statement: 'a DELETE FIELD statement',
  create_field_statement: 'a CREATE FIELD statement',
  attach_statement: 'an ATTACH statement',
  detach_statement: 'a DETACH statement',
  move_statement: 'a MOVE statement',
  log_statement: 'a LOG statement',
  eval_statement: 'an EVAL statement',
  throw_statement: 'a THROW statement',
  resignal_statement: 'a RESIGNAL statement',
  iterate_statement: 'an ITERATE statement',
  leave_statement: 'a LEAVE statement',
  passthru_statement: 'a PASSTHRU statement',
};

/**
 * When NO statement node survived — the broken statement is a raw token
 * ERROR — its own opening keyword still says what it was trying to be.
 */
const DAMAGED_LEADING_KW_PHRASES: Record<string, string> = {
  kw_SET: 'a SET statement',
  kw_DECLARE: 'a DECLARE statement',
  kw_IF: 'an IF statement',
  kw_WHILE: 'a WHILE loop',
  kw_REPEAT: 'a REPEAT loop',
  kw_FOR: 'a FOR loop',
  kw_LOOP: 'a LOOP block',
  kw_CASE: 'a CASE statement',
  kw_CALL: 'a CALL statement',
  kw_RETURN: 'a RETURN statement',
  kw_PROPAGATE: 'a PROPAGATE statement',
  kw_INSERT: 'an INSERT statement',
  kw_UPDATE: 'an UPDATE statement',
  kw_DELETE: 'a DELETE statement',
  kw_ATTACH: 'an ATTACH statement',
  kw_DETACH: 'a DETACH statement',
  kw_MOVE: 'a MOVE statement',
  kw_LOG: 'a LOG statement',
  kw_EVAL: 'an EVAL statement',
  kw_THROW: 'a THROW statement',
  kw_RESIGNAL: 'a RESIGNAL statement',
  kw_COMMIT: 'a COMMIT statement',
  kw_ROLLBACK: 'a ROLLBACK statement',
};

/** `a`/`an` before a derived uppercase phrase like `INSERT statement`. */
function articleFor(phrase: string): string {
  return /^[AEIOU]/.test(phrase) ? 'an' : 'a';
}

/** Labels for constructs that can be left incomplete (see `expectedPhrase`). */
const CONSTRUCT_LABELS: Record<string, string> = {
  datatype: 'a data type',
  literal: 'a literal value',
  expression: 'an expression',
  field_reference: 'a field reference',
  path_name: 'a path',
  schema_name: 'a schema name',
  function_call: 'a function call',
  routine_parameter: 'a parameter (IN / OUT / INOUT name type)',
  declare_item: 'a declared name and type',
  broker_schema_statement: 'a schema name after BROKER SCHEMA',
  create_module_statement: 'a module type and name after CREATE',
  create_routine_statement: 'a routine name and parameter list after CREATE',
  set_statement: 'an assignment after SET',
  declare_statement: 'a declared name after DECLARE',
  propagate_statement: 'a propagation target after PROPAGATE',
};

export function analyzeDocument(tree: Tree, source?: string): DocAnalysis {
  const declaredNames: DeclaredName[] = [];
  const setTargets: SetTarget[] = [];
  const syntaxIssues: SyntaxIssue[] = [];
  const modules: ModuleInfo[] = [];
  const routines: RoutineInfo[] = [];
  const schemas: SchemaInfo[] = [];
  const references: Reference[] = [];

  // The damaged-region namer clamps a named diagnostic to one line, which
  // needs the document text. The caller (server.ts) has it; tests may not,
  // and then serialising the tree once — only ever in the presence of named
  // damage, never on the clean-document path — is the fallback.
  let docText: string | undefined = source;
  const text = (): string => (docText ??= tree.rootNode.text);

  /** The end of the line `node` starts on (same row, one line at most). */
  const endOfLineAt = (node: SyntaxNode): { row: number; column: number } => {
    const src = text();
    const nl = src.indexOf('\n', node.startIndex);
    return {
      row: node.startPosition.row,
      column:
        node.startPosition.column +
        (nl === -1 ? src.length - node.startIndex : nl - node.startIndex),
    };
  };

  /**
   * Report an ERROR region as a diagnostic (ISSUES.md I-12): a bare
   * `Syntax error.` spanning multiple lines from the middle of a statement
   * is not actionable, so name the construct it sits in and underline that
   * construct's first line instead. Two readings, in order: a surviving
   * statement ancestor names the context (`SET x = 1` swallowed as a
   * DECLARE's initial value → point at the DECLARE line); with no statement
   * node at all, the damaged region's own opening keyword says what it was
   * trying to be (`IF x = THEN` → an IF statement). Neither → the old
   * honest message over the full region.
   */
  const describeDamagedRegion = (node: SyntaxNode): { message: string; range: Range } => {
    const named = (phrase: string, anchor: SyntaxNode) => ({
      message: `Syntax error in ${phrase}.`,
      range: Range.create(
        anchor.startPosition.row,
        anchor.startPosition.column,
        endOfLineAt(anchor).row,
        endOfLineAt(anchor).column
      ),
    });
    // 1. A region that opens with a statement keyword IS the failed
    //    statement (error recovery left it as raw tokens): name it and
    //    keep its own — precise — position.
    const kids = node.children;
    const first = kids[0];
    if (first) {
      if (first.type === 'kw_CREATE') {
        // CREATE spans modules and routines; the next words say which.
        for (const early of kids.slice(0, 4)) {
          if (early.type === 'kw_MODULE') return named('a module definition', node);
          if (early.type === 'kw_FUNCTION' || early.type === 'kw_PROCEDURE')
            return named('a routine definition', node);
        }
      } else {
        const phrase = DAMAGED_LEADING_KW_PHRASES[first.type];
        if (phrase) return named(phrase, node);
      }
    }
    // 2. Otherwise the nearest surviving STATEMENT ancestor says what the
    //    damage sits in, and its first line is where the reader must look
    //    (the swallowed-`;` shape: the ERROR is in the initial-value slot,
    //    the fix is on the DECLARE line). Climb past `esql_statement` (a
    //    bare wrapper) and `routine_body` (naming the BEGIN block of a
    //    stray token helps nobody), and stop at the module/routine
    //    containers: a two-token ERROR after the body must keep its own
    //    position rather than every line of the file pointing at
    //    `CREATE …` — an unmatched container says less than a precise
    //    range does.
    for (let a = node.parent; a && a.type !== 'source_file'; a = a.parent) {
      if (
        a.type === 'esql_statement' ||
        a.type === 'routine_body' ||
        a.type === 'create_module_statement' ||
        a.type === 'create_routine_statement'
      )
        continue;
      const stored = DAMAGED_CONSTRUCT_PHRASES[a.type];
      const derived =
        stored ??
        (a.type.endsWith('_statement')
          ? a.type.replace(/_statement$/, '').replace(/_/g, ' ').trim().toUpperCase() + ' statement'
          : undefined);
      if (derived) return named(stored ? derived : `${articleFor(derived)} ${derived}`, a);
    }
    // 3. Nothing to say beyond the truth: the bare message, own range.
    return { message: 'Syntax error.', range: rangeOf(node) };
  };

  /**
   * Records the module / routine / BROKER SCHEMA a node introduces and returns
   * the scope its children live in (`scope` unchanged when the node is not one
   * of those, or when its header is too damaged to identify).
   */
  const openScope = (
    node: SyntaxNode,
    kids: readonly SyntaxNode[],
    scope: WalkScope
  ): WalkScope => {
    switch (node.type) {
      case 'broker_schema_statement': {
        const schemaNode = childOf(kids, 'schema_name');
        if (schemaNode) {
          schemas.push({
            name: schemaNode.text.replace(/^\./, ''),
            range: rangeOf(schemaNode),
          });
        }
        return scope;
      }
      case 'create_module_statement': {
        const info = moduleInfo(node, kids);
        if (!info) return scope;
        modules.push(info);
        return { visible: info.range, moduleName: info.name };
      }
      case 'create_routine_statement': {
        const info = routineInfo(node, kids, scope.moduleName);
        if (!info) return scope;
        routines.push(info);
        return {
          visible: info.bodyRange ?? info.declRange,
          moduleName: info.moduleName,
          routine: info,
        };
      }
      default:
        return scope;
    }
  };


  const visit = (node: SyntaxNode, scope: WalkScope, parentType?: string, underDamaged = false): void => {
    // Read the child list ONCE per node. `node.children` allocates a fresh array
    // of fresh node wrappers on every read, and this walk looks at several fields
    // of the same node, so reading it per field multiplied the work: a full walk
    // of a 2300-node document costs 7 ms reading once, 13.7 ms reading twice
    // (ISSUES.md I-20).
    const kids = node.children;
    if (node.type === 'ERROR' || node.type === 'MISSING' || node.isMissing || isInsertedNode(node)) {
      if (!underDamaged) {
        syntaxIssues.push(
          isInsertedNode(node)
            ? { message: expectedPhrase(node.type, parentType), range: rangeOf(node) }
            : describeDamagedRegion(node)
        );
      }
      // Error recovery preserves intact subtrees inside the damaged region
      // (e.g. a complete CREATE FUNCTION inside a module missing its
      // END MODULE). Mine those for semantics — declarations, SET targets,
      // nested routines — by descending into EVERY child, damaged ones
      // included (ISSUES.md I-6: skipping `hasError` children made the outline
      // and the undeclared-variable check go quiet exactly where the buffer is
      // mid-typing, which is where the fallback still answers, and the two
      // paths must agree). `underDamaged` keeps this honest on the diagnostic
      // side: a damaged node below an already-reported one adds no second
      // `Syntax error.` inside the outer region (the outermost-only rule
      // parser.test.ts asserts).
      //
      // The damaged node's OWN header usually survived (an unterminated
      // module still has CREATE COMPUTE MODULE <name>), so still open its
      // scope: the outline and go-to-definition must keep working while the
      // file is incomplete.
      const inner = openScope(node, kids, scope);
      const moduleInfo = inner === scope ? damagedModuleInfo(node) : null;
      if (moduleInfo) modules.push(moduleInfo);
      const damagedScope: WalkScope = moduleInfo
        ? { visible: moduleInfo.range, moduleName: moduleInfo.name }
        : inner;
      for (const child of kids) visit(child, damagedScope, node.type, true);
      return;
    }

    switch (node.type) {
      case 'broker_schema_statement':
      case 'create_module_statement':
      case 'create_routine_statement': {
        const inner = openScope(node, kids, scope);
        for (const child of kids) visit(child, inner, node.type, underDamaged);
        return; // handled: do not descend twice
      }
      case 'declare_statement': {
        // Direct identifier children are the declared names — a multi-name
        // `DECLARE a, b TYPE` declares every one of them. Handlers are a
        // separate node type (declare_handler_statement) and never land
        // here. The REFERENCE TO target is a field_reference child, not an
        // identifier, so it is not mistaken for a declaration. Quoted names
        // (`DECLARE "script-encoded-hostname" …`) are grammar-only: the
        // pattern path indexes plain identifiers too, so both paths stay
        // silent about them together.
        const typeNode = childOf(kids, 'datatype');
        if (typeNode) {
          const constant = kids.some((c) => c.type === 'kw_CONSTANT');
          const detail = (constant ? 'CONSTANT ' : '') + typeNode.text.toUpperCase();
          for (const child of kids) {
            if (child.type === 'identifier') {
              declaredNames.push({
                name: child.text,
                detail,
                range: rangeOf(child),
                kind: 'variable',
                constant,
                shared: kids.some((c) => c.type === 'kw_SHARED'),
                scope: scope.visible,
              });
            }
          }
        }
        // No datatype = the namespace ALIAS form (family A: IBM's
        // `DECLARE prefixOne NAMESPACE 'http://www.example.com/PO1';`).
        // Its value is an implicitly constant CHARACTER (DECLARE page,
        // note 6) used as a path prefix — a different kind of thing from
        // a declared variable, so the outline and completion must not
        // offer it as one. The NAME alias (`DECLARE Schema1 NAME 'Joe';`)
        // keeps parsing as a NAME-typed variable (the grammar's reason is
        // in the declare_statement comment): it is indexed as before, and
        // telling alias from variable is analyzer territory, not the
        // parser's.
        break; // keep descending: a recovered missing ';' lives in here
      }
      case 'routine_parameter': {
        // One identifier child: the parameter name. Parameters are declared in
        // the header (outside BEGIN..END) but visible throughout the routine,
        // so their scope is the whole CREATE … END statement.
        const typeNode = childOf(kids, 'datatype');
        const visible = scope.routine ? scope.routine.declRange : scope.visible;
        for (const child of kids) {
          if (child.type === 'identifier') {
            declaredNames.push({
              name: child.text,
              detail: typeNode
                ? `parameter ${oneLine(typeNode.text).toUpperCase()}`
                : 'parameter',
              range: rangeOf(child),
              kind: 'parameter',
              constant: kids.some((c) => c.type === 'kw_CONSTANT'),
              scope: visible,
            });
          }
        }
        break; // keep descending for recovered missing tokens
      }
      case 'set_statement': {
        const target = childOf(kids, 'field_reference');
        if (target && target.childCount === 1) {
          const only = target.children[0];
          if (only.type === 'identifier') {
            // Bare `SET x = …` (not a message-tree path like `SET a.b = …`).
            setTargets.push({ name: only.text, range: rangeOf(only) });
          }
        }
        break; // descend (harmless: SET contains no nested statements)
      }
      case 'field_reference': {
        // A single-identifier field reference IS a variable use: ESQL parses
        // a bare `x` as a field reference with no path elements. Anything
        // with path elements (`a.b`, `a[1]`, `(XML.Element)T`) is a
        // message-tree path, not a variable.
        if (kids.length === 1 && kids[0].type === 'identifier') {
          references.push({
            name: kids[0].text,
            range: rangeOf(kids[0]),
            kind: 'variable',
          });
        }
        break; // descend: dynamic `{expression}` path parts hold references
      }
      case 'function_call': {
        // The name is the first child: an identifier, or one of the five
        // clause-function words when they carry a comma call
        // (`SUBSTRING(s, 2, 1)`) — those words lex as keywords now.
        const name = kids.find(
          (c) => c.type === 'identifier' || c.type.startsWith('kw_')
        );
        if (name) {
          references.push({ name: name.text, range: rangeOf(name), kind: 'routine' });
        }
        break; // descend into the arguments
      }

      // Keyword-clause calls (TRIM/SUBSTRING/POSITION/OVERLAY/ASBITSTREAM):
      // the called word is the node's first child, and the reference is
      // what a comma call to the same name would have produced, so hover
      // and completion treat the two spellings alike.
      case 'position_clause_function':
      case 'trim_clause_function':
      case 'overlay_clause_function':
      case 'substring_clause_function':
      case 'asbitstream_clause_function': {
        const word = kids[0];
        references.push({ name: word.text, range: rangeOf(word), kind: 'routine' });
        break; // descend into the arguments
      }
      case 'call_statement': {
        // `CALL [Schema.]Routine (…)`: the last name of the qualified name is
        // the routine; the whole dotted text is kept for qualified matching.
        const qualified = childOf(kids, 'qualified_name');
        if (qualified) {
          const parts = qualified.children.filter((c) => c.type === 'identifier');
          const last = parts[parts.length - 1];
          if (last) {
            references.push({
              name: last.text,
              range: rangeOf(last),
              kind: 'routine',
              qualified: qualified.text.replace(/^\./, ''),
            });
          }
        }
        break; // descend into arguments and the INTO target
      }
    }

    for (const child of kids) visit(child, scope, node.type, underDamaged);
  };

  visit(tree.rootNode, { visible: rangeOf(tree.rootNode) });
  // Two sibling damage clusters inside one construct get clamped to the same
  // named line (I-12) — from here they are indistinguishable, and a doubled
  // identical diagnostic is I-17 noise again. Keep the first of each.
  const seenIssues = new Set<string>();
  const uniqueIssues = syntaxIssues.filter((i) => {
    const key = `${i.message}@${i.range.start.line}:${i.range.start.character}:${i.range.end.line}:${i.range.end.character}`;
    if (seenIssues.has(key)) return false;
    seenIssues.add(key);
    return true;
  });
  return {
    declaredNames,
    setTargets,
    syntaxIssues: uniqueIssues,
    modules,
    routines,
    schemas,
    references,
  };
}

/** ------------------------------------------------------------------
 *  Semantic tokens
 *  ------------------------------------------------------------------ */

/** TextMate capture scopes from queries/highlights.scm -> LSP token types. */
const TOKEN_TYPE_MAP: Record<string, string> = {
  comment: 'comment',
  string: 'string',
  'string.special': 'string',
  number: 'number',
  constant: 'constant',
  'constant.builtin': 'constant',
  keyword: 'keyword',
  'keyword.control': 'keyword',
  type: 'type',
  variable: 'variable',
  parameter: 'parameter',
  'function.call': 'function',
  'function.definition': 'function',
  module: 'namespace',
  label: 'label',
  operator: 'operator',
};

/** Legend advertised in the initialize result; index = token type index. */
export const SEMANTIC_TOKEN_TYPES: string[] = [
  'namespace',
  'type',
  'function',
  'variable',
  'parameter',
  'keyword',
  'comment',
  'string',
  'number',
  'operator',
  'label',
];

interface RawToken {
  line: number;
  start: number;
  end: number;
  type: string;
}

/**
 * Semantic tokens for a parsed document, in LSP relative encoding
 * (quintuples: deltaLine, deltaStartChar, length, tokenType, tokenModifiers).
 *
 * The highlights query captures overlapping nodes (e.g. `(datatype) @type`
 * and its child `(kw_INT) @type`); we keep the OUTERMOST capture of each
 * span and drop anything overlapping an already-kept token. Tokens spanning
 * several lines (block comments) are skipped — per-line tokens only.
 *
 * `source` is the document the tree was built from, and it is only there to
 * clamp each token to the length the *client* has for that line: a token must
 * never run past the end of the line the client counts, and a grammar token can
 * (a comment token includes its `\r`, so on a CRLF file every comment reached one
 * column too far — ISSUES.md I-18). Clamping here makes that a protocol
 * guarantee rather than a property of whatever the grammar happens to match.
 */
export function semanticTokensForTree(tree: Tree, source: string): number[] | null {
  if (!highlightsQuery) return null;
  let captures: Array<{ name: string; node: SyntaxNode }>;
  try {
    captures = highlightsQuery.captures(tree.rootNode);
  } catch {
    return null;
  }

  const lineLengths = linesOf(source).map((l) => l.length);
  const tokens: RawToken[] = [];
  for (const cap of captures) {
    const type = TOKEN_TYPE_MAP[cap.name];
    if (!type) continue;
    const s = cap.node.startPosition;
    const e = cap.node.endPosition;
    if (s.row !== e.row) continue; // single-line tokens only
    const lineLength = lineLengths[s.row];
    const end = lineLength === undefined ? e.column : Math.min(e.column, lineLength);
    if (end <= s.column) continue;
    tokens.push({ line: s.row, start: s.column, end, type });
  }

  // Start ascending; for the same start the longest (outermost) first.
  tokens.sort((a, b) => a.line - b.line || a.start - b.start || b.end - a.end);

  const data: number[] = [];
  let prevLine = 0;
  let prevStart = 0;
  let lastKeptLine = -1;
  let lastKeptEnd = -1;
  for (const t of tokens) {
    if (t.line === lastKeptLine && t.start < lastKeptEnd) continue; // overlap
    const typeIndex = SEMANTIC_TOKEN_TYPES.indexOf(t.type);
    if (typeIndex === -1) continue;
    const deltaLine = t.line - prevLine;
    const deltaStart = deltaLine === 0 ? t.start - prevStart : t.start;
    data.push(deltaLine, deltaStart, t.end - t.start, typeIndex, 0);
    prevLine = t.line;
    prevStart = t.start;
    lastKeptLine = t.line;
    lastKeptEnd = t.end;
  }
  return data;
}
