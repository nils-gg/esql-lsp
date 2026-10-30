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
import { linesOf, scan, unquoteESQLName } from './scanner';
import { ESQL_KEYWORDS } from './data/esqlData';
import { didYouMean } from './suggest';
import { bareTargetsFromSource, declarationsFromSource, routinesFromSource } from './definitions';
import { byteOffsetsFor, setTreePositionEncoding } from './positions';

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
  /**
   * The structural shape this message describes, when a semantic check words
   * it better (CODE_REVIEW.md E-7). `module-definition`: damage swallowed a
   * module header — if that module is ALSO missing its END MODULE, the
   * `missing-end-module` diagnostic owns the line and diagnostics.ts drops
   * this phrasing (one diagnostic per root cause; the structure check knows
   * the module's name).
   */
  kind?: 'module-definition';
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
  /**
   * The `DECLARE prefix NAMESPACE 'uri'` alias names — deliberately NOT in
   * `declaredNames` (the G-5/C-7 stance: the outline and completion must not
   * offer a path prefix as a variable), but they DO bind the name: ESQL
   * reads them as implicitly constant CHARACTER values (DECLARE page, note
   * 6), so the undeclared-READ check (E-5) must count them — the flat
   * extractor already indexes them (detail `NAMESPACE`), and a mode split
   * here is the E-3 failure all over again.
   */
  namespaceAliases: DeclaredName[];
  /**
   * Every `select_expression` range. Bare words inside a SELECT are column,
   * table and alias names — never ESQL variables — so the undeclared-READ
   * check (E-5) must not treat references there as variable reads.
   */
  selectExpressions: Range[];
  /**
   * Every outermost `ERROR` node's range — the same regions E-2b mines for
   * declarations. The undeclared-READ check (E-5) refuses to vouch for a
   * name inside damage: recovery invents or loses references there, and
   * `SET x = Fn(` mid-typing must not read as "variable 'Fn' never
   * declared" (it is a call, and it may be a routine).
   */
  errorRegions: Range[];
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
    probeTreePositionEncoding();
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
 * Measure what THIS binding reports in (positions.ts / list.md issue 1):
 * parse a line holding CJK and emoji before a known identifier, then compare
 * that identifier's `startIndex` and `startPosition.column` to the UTF-16
 * and UTF-8 candidates. node-tree-sitter 0.25.1 measures as utf16-index +
 * byte-column — two different spaces inside one node — which is exactly the
 * trap this probe exists to catch, on every binding, at startup.
 */
function probeTreePositionEncoding(): void {
  try {
    const src = "SET a = '\u4f60\u597d\ud83d\ude00'; SET bb = 2;";
    // Measure the parser documents are ACTUALLY parsed with: several native
    // tree-sitter libraries can be loaded in one process (the runtime
    // package, the grammar's bundled copy) and they may disagree.
    const tree: any = runtimeParser.parse(src, undefined);
    const wantIdx = src.indexOf('bb = 2');
    const idxUtf8 = Buffer.byteLength(src.slice(0, wantIdx), 'utf8');
    const colUtf16 = wantIdx; // single-line document
    const colUtf8 = Buffer.byteLength(src.slice(0, wantIdx), 'utf8');
    let start = -1;
    let column = -1;
    // Manual stack walk over children: the cursor API differs between the
    // native tree-sitter copies that may load, plain node access does not.
    const stack: any[] = [tree.rootNode];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === 'identifier' && n.text === 'bb') {
        start = n.startIndex;
        column = n.startPosition.column;
        break;
      }
      for (let c = n.childCount - 1; c >= 0; c--) {
        const ch = n.children[c];
        if (ch) stack.push(ch);
      }
    }
    if (start >= 0) {
      const indexes = start === idxUtf8 && idxUtf8 !== wantIdx ? 'utf8' : 'utf16';
      let byteCols: boolean;
      if (column === colUtf8 && colUtf8 !== colUtf16) byteCols = true;
      else if (column === colUtf16) byteCols = false;
      else byteCols = true; // unrecognised: keep the measured regime
      setTreePositionEncoding(indexes, byteCols);
    }
    console.error(
      `esql-lsp: position probe start=${start} column=${column} (utf16 wants ${wantIdx}/${colUtf16}, utf8 wants ${idxUtf8}/${colUtf8})`
    );
  } catch (err) {
    console.error('esql-lsp: position probe failed:', String(err));
    /* keep the defaults (measured regime) */
  }
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

/**
 * A node → LSP-Range mapper. `analyzeDocument` builds one bound to the
 * document's UTF-8 offset map (positions.ts); every range the tree path
 * publishes goes through it, because a raw `node.startPosition.column` is a
 * BYTE column and a raw `node.startIndex` a byte offset — both meaningless to
 * an LSP client the moment the document holds a single non-ASCII character.
 */
type NodeRange = (node: SyntaxNode) => Range;

/**
 * The quoted_identifier token WITHOUT its quotes, positions included — the
 * range a cursor in the name agrees with, and what QUOTED_DECLARE_RE
 * records on the pattern path (G-5 parity). The ±1 trims are quote characters
 * (always ASCII), so they stay valid in the converted character space.
 */
function innerQuotedRange(node: SyntaxNode, toRange: NodeRange): Range {
  const r = toRange(node);
  return Range.create(
    r.start.line,
    r.start.character + 1,
    r.end.line,
    Math.max(r.start.character + 1, r.end.character - 1)
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

function moduleInfo(
  node: SyntaxNode,
  kids: readonly SyntaxNode[],
  toRange: NodeRange
): ModuleInfo | null {
  const nameNode = childOf(kids, 'identifier');
  if (!nameNode) return null;
  return {
    name: nameNode.text,
    kind: moduleKind(kids),
    range: toRange(node),
    nameRange: toRange(nameNode),
  };
}

function routineInfo(
  node: SyntaxNode,
  kids: readonly SyntaxNode[],
  moduleName: string | undefined,
  toRange: NodeRange
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
    range: toRange(nameNode),
    declRange: toRange(node),
    bodyRange: body ? toRange(body) : undefined,
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
function damagedModuleInfo(node: SyntaxNode, toRange: NodeRange): ModuleInfo | null {
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
      range: toRange(node),
      nameRange: toRange(nameNode),
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

/**
 * Words that BEGIN a statement. An ERROR region that opens with one of these
 * while sitting inside a still-open, `;`-terminated statement is not damage
 * INSIDE a statement — it is the seam BETWEEN two: the author dropped a `;`
 * and error recovery swallowed the next statement's opening tokens into the
 * unfinished one (CODE_REVIEW.md E-8; E-2's file-wide cascade is the same
 * root cause one level up). BEGIN/END are deliberately absent: they close
 * blocks rather than open statements, and `SET x = 1` followed by `END;` is
 * repaired as a token INSERTION (`Missing syntax: expected ';'`), so a region
 * opening with them never reaches this test.
 */
const STATEMENT_OPENERS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(DAMAGED_LEADING_KW_PHRASES).map((k) => k.slice('kw_'.length)),
  'CREATE',
  'BROKER',
]);

/** Matches a statement-opening word anywhere in (uppercased, masked) text. */
const OPENER_SCAN_RE = new RegExp(`\\b(?:${[...STATEMENT_OPENERS].join('|')})\\b`);

/**
 * The keyword a damaged region's opening word was probably reaching for
 * (E-1's did-you-mean; the move E-10 wants everywhere). Only a NON-keyword
 * word can be a typo — `IF` in the wrong place is a misplaced statement, not
 * a misspelling, and guessing around it is noise. Short words sit within two
 * edits of unrelated keywords (`bad`→`BY` at distance 2), so the transposition
 * allowance (distance 2, which covers DELCARE→DECLARE) is earned at five
 * letters; shorter words must be one edit away.
 */
function keywordSuggestion(word: string): string | undefined {
  if (!word || ESQL_KEYWORDS.includes(word.toUpperCase())) return undefined;
  return didYouMean(word, ESQL_KEYWORDS, word.length < 5 ? 1 : 2)[0];
}

/**
 * E-10's unclosed-paren pointer. When the grammar INSERTS a `)` or `]` to
 * repair an expression, the matching opener is a visible child of the node
 * the insertion landed in — so say where it is rather than leaving the reader
 * to count parens (PLAN task 10: `expected ')' here — this '(' on line 8 is
 * unclosed`). Only what the grammar EXPOSES is claimed: the parent's own
 * children are scanned, and an opener it hid deeper stays unmentioned. The
 * inserted token itself is zero-width and must not pair with its opening.
 */
function unclosedParenClause(token: SyntaxNode, parent: SyntaxNode | undefined): string {
  const openType = token.type === ')' ? '(' : token.type === ']' ? '[' : undefined;
  if (!openType || !parent) return '';
  let depth = 0;
  let unclosed: SyntaxNode | undefined;
  for (const c of parent.children) {
    if (c.type === openType) {
      depth++;
      unclosed = c;
    } else if (c.type === token.type && c.endIndex > c.startIndex && depth > 0) {
      depth--;
      if (depth === 0) unclosed = undefined;
    }
  }
  // 1-based for a human-readable message (ranges stay 0-based LSP).
  return unclosed ? ` — this '${openType}' on line ${unclosed.startPosition.row + 1} is unclosed.` : '';
}

/** Full message for a grammar-inserted token: the phrase plus any paren pointer. */
function insertionMessage(token: SyntaxNode, parent: SyntaxNode | undefined): string {
  const phrase = expectedPhrase(token.type, parent?.type);
  const clause = unclosedParenClause(token, parent);
  return clause ? `${phrase.replace(/\.$/, '')}${clause}` : phrase;
}

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
  // Outermost ERROR regions (E-2b): the mining pass reads their text with the
  // pattern extractors after the walk. MISSING/inserted nodes are zero-width
  // and hold no statements, so only real regions qualify.
  const damagedRegions: SyntaxNode[] = [];
  const modules: ModuleInfo[] = [];
  const routines: RoutineInfo[] = [];
  const schemas: SchemaInfo[] = [];
  const references: Reference[] = [];
  const selectExpressions: Range[] = [];
  const namespaceAliases: DeclaredName[] = [];

  // The damaged-region namer clamps a named diagnostic to one line, which
  // needs the document text. The caller (server.ts) has it; tests may not,
  // and then serialising the tree once — only ever in the presence of named
  // damage, never on the clean-document path — is the fallback.
  let docText: string | undefined = source;
  const text = (): string => (docText ??= tree.rootNode.text);

  // The byte→UTF-16 translator for every tree offset this analysis touches
  // (positions.ts). Building it costs one pass over the text — the same
  // laziness rule as `text()` above: pure-ASCII documents pay nothing.
  let posMap: ReturnType<typeof byteOffsetsFor> | undefined;
  const pos = (): ReturnType<typeof byteOffsetsFor> =>
    (posMap ??= byteOffsetsFor(text()));

  /** The node's LSP Range — the ONLY sanctioned way to leave tree space. */
  const toRange = (node: SyntaxNode): Range => {
    const p = pos();
    const s = p.point(node.startPosition.row, node.startPosition.column);
    const e = p.point(node.endPosition.row, node.endPosition.column);
    return Range.create(s.line, s.character, e.line, e.character);
  };

  /** The node's span as string indices into `text()` (regex/slice space). */
  const toSlice = (node: SyntaxNode): { from: number; to: number } => ({
    from: pos().index(node.startIndex),
    to: pos().index(node.endIndex),
  });

  /** The end of the line `node` starts on (same row, one line at most). */
  const endOfLineAt = (node: SyntaxNode): { row: number; column: number } => {
    const src = text();
    const p = pos();
    const startStr = p.index(node.startIndex);
    // End the line where the CLIENT ends it: LF, CRLF or lone CR. Scanning
    // for '\n' alone trusted a property `src` may not have — `text()` is the
    // client's ORIGINAL text (parse() normalises lone CRs for the tree only),
    // so on a CR-only document the search ran to the next LF or EOF and the
    // "one line at most" clamp emitted an end column past the end of the
    // line. Stopping at the CR of a CRLF pair also trims the '\r' the old
    // search had included — I-18's rule for tokens applies to these ranges
    // too (correctness review 2026-10-29).
    const termRe = /[\n\r]/g;
    termRe.lastIndex = startStr;
    const term = termRe.exec(src);
    const endStr = term ? term.index : src.length;
    const anchor = p.point(node.startPosition.row, node.startPosition.column);
    return {
      row: anchor.line,
      // String-index difference = character count between two codepoint
      // boundaries, which is the column distance the client counts.
      column: anchor.character + (endStr - startStr),
    };
  };

  // Masked document text (comments and string contents blanked, byte offsets
  // identical — see scanner.ts): the word a message quotes or measures must
  // be a token the parser saw, never a word inside a comment. Computed once
  // per analysis and only when there is damage to describe.
  let maskedText: string | undefined;
  const masked = (): string => (maskedText ??= scan(text()).masked);

  /** The masked text of `node`'s span (tree bytes → string indices first). */
  const maskedRegion = (node: SyntaxNode): string => {
    const { from, to } = toSlice(node);
    return masked().slice(from, to);
  };

  /** The word a region opens with; '' when it opens with anything else. */
  const regionFirstWord = (node: SyntaxNode): string =>
    maskedRegion(node).match(/^\s*([A-Za-z_]\w*)/)?.[1] ?? '';

  /** The first quotable thing in a region: a word or a punctuation run. */
  const regionQuotedToken = (node: SyntaxNode): string =>
    maskedRegion(node).match(/^\s*([A-Za-z_]\w*|[^\w\s]+)/)?.[1] ?? '';

  /** {row, column} of a STRING INDEX into `src` (regex/slice space). */
  const positionAt = (stringIndex: number): { row: number; column: number } => {
    const p = pos().positionOfStringIndex(stringIndex);
    return { row: p.line, column: p.character };
  };

  /**
   * The E-8 shape read off the tree: the region opens with a statement
   * keyword, sits inside a `*_statement` node whose masked text ENDS with
   * `;`, and no container stands between — the signature of recovery pasting
   * the FOLLOWING statement's opening tokens into the statement that never
   * got its terminator (the swallowed shape closes with the second
   * statement's own `;`). The fix is not inside either statement: it is the
   * point where the missing `;` belongs. Heuristic mode's Hint already said
   * this (diagnostics.ts); grammar mode replying `Syntax error in a SET
   * statement.` said less (E-8), so this reading runs before the naming ones.
   */
  const unterminatedStatement = (node: SyntaxNode): { message: string; range: Range } | null => {
    const first = regionFirstWord(node);
    if (!first || !STATEMENT_OPENERS.has(first.toUpperCase())) return null;
    for (let a = node.parent; a && a.type !== 'source_file'; a = a.parent) {
      // Containers stop the climb: a module/routine's trailing `;` closes
      // its END/END MODULE, not a swallowed statement, and a region sitting
      // loose in a body belongs to the naming paths, not to this one.
      if (
        a.type === 'routine_body' ||
        a.type === 'create_module_statement' ||
        a.type === 'create_routine_statement'
      )
        return null;
      if (a.type === 'esql_statement' || !a.type.endsWith('_statement')) continue;
      const aSlice = toSlice(a);
      if (!masked().slice(aSlice.from, aSlice.to).trimEnd().endsWith(';')) return null;
      // E-2a: the cascade. When the region's text holds ANOTHER statement
      // opener past its first word, recovery swallowed more than the next
      // statement — one forgotten `;` ate a whole run of them. That shape
      // earns a message naming the unterminated statement and the word that
      // followed it (the review's `This DECLARE statement is not terminated
      // — expected ';' before 'CREATE'.`); a single swallowed statement
      // keeps the plain wording. Masked text again: a BEGIN inside a comment
      // cascades nothing.
      const regionText = maskedRegion(node);
      const lead = regionText.match(/^\s*[A-Za-z_]\w*/)?.[0].length ?? first.length;
      const cascaded = OPENER_SCAN_RE.test(regionText.slice(lead).toUpperCase());
      const kind = a.type
        .replace(/_statement$/, '')
        .replace(/_/g, ' ')
        .trim()
        .toUpperCase();
      // The terminator's slot: from just past the last non-blank character
      // before the region, through the whitespace the `;` belongs in. The
      // walk runs in string-index space (a byte walk of a JS string would
      // land mid-codepoint the moment the line holds non-ASCII).
      const src = text();
      const nodeStartStr = pos().index(node.startIndex);
      const aStartStr = aSlice.from;
      let idx = nodeStartStr - 1;
      while (idx > aStartStr && /\s/.test(src[idx])) idx--;
      if (idx <= aStartStr || /\s/.test(src[idx])) return null;
      const from = positionAt(idx + 1);
      const nodeStart = pos().point(node.startPosition.row, node.startPosition.column);
      return {
        message: cascaded
          ? `This ${kind} statement is not terminated — expected ';' before '${first}'.`
          : "Statement is not terminated — expected ';' here.",
        range: Range.create(from.row, from.column, nodeStart.line, nodeStart.character),
      };
    }
    return null;
  };

  /**
   * Report an ERROR region as a diagnostic (ISSUES.md I-12; CODE_REVIEW.md
   * E-1/E-8). A bare `Syntax error.` spanning lines is not actionable, so
   * the builder never goes silent — readings in priority order:
   *   0. the region is the SEAM between two statements: name the missing
   *      `;` and point at its slot (E-8);
   *   1. the region's own opening keyword says what it was trying to be
   *      (`IF x = THEN` → an IF statement), at its own precise position;
   *   2. a surviving statement ancestor names what the damage sits in,
   *      clamped to that construct's first line (`SET x = 1 2` → the SET
   *      line);
   *   3. failing all of that, the region's opening token is QUOTED
   *      (`Unexpected 'SETN' here.`) — E-1's complaint was that the found
   *      token was never said, and `SETN`→`SET` is one transposition the
   *      reader used to have to spot by hand.
   * Every message built here carries a did-you-mean suffix when the region's
   * opening word is a near-miss for a keyword (E-10's move). The only shape
   * that keeps the bare text is a region of pure comment damage: nothing to
   * name, nothing to quote.
   */
  const describeDamagedRegion = (node: SyntaxNode): SyntaxIssue => {
    const seam = unterminatedStatement(node);
    if (seam) return seam;
    // E-1: measured against the keyword table once per region.
    const hint = (() => {
      const s = keywordSuggestion(regionFirstWord(node));
      return s ? ` Did you mean '${s}'?` : '';
    })();
    // E-7: damage naming a MODULE DEFINITION is tagged so diagnostics.ts can
    // drop it when `missing-end-module` fires on the same line (one
    // diagnostic per forgotten END MODULE). Deriving the tag from the phrase
    // covers every naming path at once — the leading-keyword one below and
    // the ancestor one — and a damaged header of a CLOSED module keeps its
    // message: nothing else reports that shape.
    const named = (phrase: string, anchor: SyntaxNode): SyntaxIssue => {
      // BOTH ends in the character space the client counts (positions.ts).
      // The start used to be the raw tree point — a BYTE column — while the
      // end was converted, so on a line with non-ASCII before the damage the
      // highlight began (bytes − UTF-16) columns too far right, breaking the
      // `toRange`-is-the-only-way-out invariant documented above (correctness
      // review 2026-10-29).
      const start = pos().point(anchor.startPosition.row, anchor.startPosition.column);
      const eol = endOfLineAt(anchor);
      return {
        message: `Syntax error in ${phrase}.${hint}`,
        ...(phrase === 'a module definition' ? { kind: 'module-definition' as const } : {}),
        range: Range.create(start.line, start.character, eol.row, eol.column),
      };
    };
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
    // 3. Nothing names the region, but its opening token still says what the
    //    parser tripped over — quote it (E-1).
    const tok = regionQuotedToken(node);
    if (tok) return { message: `Unexpected '${tok}' here.${hint}`, range: toRange(node) };
    // A region whose masked text holds no token (comment-only damage) has no
    // name and nothing to quote: the one residue where bare text is honest.
    return { message: 'Syntax error.', range: toRange(node) };
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
            range: toRange(schemaNode),
          });
        }
        return scope;
      }
      case 'create_module_statement': {
        const info = moduleInfo(node, kids, toRange);
        if (!info) return scope;
        modules.push(info);
        return { visible: info.range, moduleName: info.name };
      }
      case 'create_routine_statement': {
        const info = routineInfo(node, kids, scope.moduleName, toRange);
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


  const visit = (node: SyntaxNode, scope: WalkScope, parent?: SyntaxNode, underDamaged = false): void => {
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
            ? { message: insertionMessage(node, parent), range: toRange(node) }
            : describeDamagedRegion(node)
        );
        if (node.type === 'ERROR') damagedRegions.push(node); // mined after the walk (E-2b)
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
      const moduleInfo = inner === scope ? damagedModuleInfo(node, toRange) : null;
      if (moduleInfo) modules.push(moduleInfo);
      const damagedScope: WalkScope = moduleInfo
        ? { visible: moduleInfo.range, moduleName: moduleInfo.name }
        : inner;
      for (const child of kids) visit(child, damagedScope, node, true);
      return;
    }

    switch (node.type) {
      case 'broker_schema_statement':
      case 'create_module_statement':
      case 'create_routine_statement': {
        const inner = openScope(node, kids, scope);
        for (const child of kids) visit(child, inner, node, underDamaged);
        return; // handled: do not descend twice
      }
      case 'declare_statement': {
        // Direct identifier children are the declared names — a multi-name
        // `DECLARE a, b TYPE` declares every one of them. Handlers are a
        // separate node type (declare_handler_statement) and never land
        // here. The REFERENCE TO target is a field_reference child, not an
        // identifier, so it is not mistaken for a declaration.
        // Quoted names (`DECLARE "script-encoded-hostname" …`) ARE indexed —
        // here and in the pattern path (QUOTED_DECLARE_RE), not silently
        // dropped (G-5; the comment here used to claim the inverse of what
        // either path does). Name and range are recorded WITHOUT the quotes,
        // the way QUOTED_DECLARE_RE records them (and how wordAtPosition
        // reports the word under a cursor inside quotes), so cursor↔
        // declaration ranges and both extraction paths agree. Doubled `""`
        // inside the name is one escaped quote in both paths.
        // The grammar emits quoted_identifier in other places too — the
        // EXTERNAL NAME/ASSEMBLY/APPDOMAIN/… clauses (a CLR class name and
        // friends: VALUES, not declarations) and field_reference (a USE).
        // Deliberately nothing else in the walk indexes names: only the
        // DECLARE name slots declare (audited for G-5).
        const typeNode = childOf(kids, 'datatype');
        if (typeNode) {
          const constant = kids.some((c) => c.type === 'kw_CONSTANT');
          const detail = (constant ? 'CONSTANT ' : '') + typeNode.text.toUpperCase();
          for (const child of kids) {
            if (child.type === 'identifier' || child.type === 'quoted_identifier') {
              const quoted = child.type === 'quoted_identifier';
              declaredNames.push({
                name: quoted ? unquoteESQLName(child.text) : child.text,
                detail,
                range: quoted ? innerQuotedRange(child, toRange) : toRange(child),
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
        // offer it as one. It DOES bind the name though, and the flat
        // extractor indexes it too — so the names land in
        // `namespaceAliases` for the checks that care about binding
        // (E-5), not about offering variables. The NAME alias
        // (`DECLARE Schema1 NAME 'Joe';`) keeps parsing as a NAME-typed
        // variable (the grammar's reason is in the declare_statement
        // comment): it is indexed as before, and telling alias from
        // variable is analyzer territory, not the parser's.
        if (kids.some((c) => c.type === 'kw_NAMESPACE')) {
          for (const child of kids) {
            if (child.type === 'identifier' || child.type === 'quoted_identifier') {
              const quoted = child.type === 'quoted_identifier';
              namespaceAliases.push({
                name: quoted ? unquoteESQLName(child.text) : child.text,
                detail: 'NAMESPACE',
                range: quoted ? innerQuotedRange(child, toRange) : toRange(child),
                kind: 'variable',
                constant: true,
                shared: false,
                scope: scope.visible,
              });
            }
          }
        }
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
              range: toRange(child),
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
            setTargets.push({ name: only.text, range: toRange(only) });
          }
        }
        break; // descend (harmless: SET contains no nested statements)
      }
      case 'select_expression': {
        // Column/table/alias words inside are NOT variable reads (E-5).
        selectExpressions.push(toRange(node));
        break; // descend: the expressions there still hold real variable refs
      }
      case 'field_reference': {
        // A single-identifier field reference IS a variable use: ESQL parses
        // a bare `x` as a field reference with no path elements. Anything
        // with path elements (`a.b`, `a[1]`, `(XML.Element)T`) is a
        // message-tree path, not a variable. The QUOTED spelling is the same
        // variable (`SET "my var" = 1`): the pattern path's `occurrences`
        // always found quoted uses, so a tree that skipped them made
        // definition/rename/hover answer differently per mode on a quoted
        // name — name and range go in unquoted, exactly like the DECLARE
        // collector above, so cursor↔reference ranges agree everywhere.
        const only = kids.length === 1 ? kids[0] : undefined;
        if (only && (only.type === 'identifier' || only.type === 'quoted_identifier')) {
          const quoted = only.type === 'quoted_identifier';
          references.push({
            name: quoted ? unquoteESQLName(only.text) : only.text,
            range: quoted ? innerQuotedRange(only, toRange) : toRange(only),
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
          references.push({ name: name.text, range: toRange(name), kind: 'routine' });
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
        references.push({ name: word.text, range: toRange(word), kind: 'routine' });
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
              range: toRange(last),
              kind: 'routine',
              qualified: qualified.text.replace(/^\./, ''),
            });
          }
        }
        break; // descend into arguments and the INTO target
      }
    }

    for (const child of kids) visit(child, scope, node, underDamaged);
  };

  visit(tree.rootNode, { visible: toRange(tree.rootNode) });
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

  // E-2b: declarations survive their own damage (CODE_REVIEW.md E-2). One
  // forgotten `;` above a module lets recovery swallow every following line
  // into one giant ERROR region: the tokens are ALL THERE — DECLARE words,
  // a whole CREATE FUNCTION header — but the tree stops NAMING them, so
  // declaredNames, routines and setTargets come back near-empty AT ONCE and
  // every consumer degrades together (the review's repro made a correctly
  // declared SHARED look undeclared). The pattern extractors see what
  // recovery dropped, so each outermost region's text gets a second pass
  // with them, results shifted back into file coordinates. The slice is
  // padded to whole lines — regions start and end mid-line and the
  // extractors are line-anchored; padding from column 0 is what keeps every
  // mined column a true file column. Best-effort BY DESIGN: text cut out of
  // its construct can miss a pattern straddling the slice edge, but
  // everything intact inside the damage lands. Tree entries come FIRST and
  // win any position clash: the padding re-reads clean neighbours at region
  // edges, and for text the parser handled normally the tree's answer is
  // the authoritative one.
  const fileEnd = toRange(tree.rootNode);
  const src = text();
  const minedKey = (name: string, r: Range) => `${name.toUpperCase()}@${r.start.line}:${r.start.character}`;
  const knownDecl = new Set(declaredNames.map((d) => minedKey(d.name, d.range)));
  const knownRoutine = new Set(routines.map((r) => minedKey(r.name, r.range)));
  const knownTarget = new Set(setTargets.map((t) => minedKey(t.name, t.range)));
  for (const region of damagedRegions) {
    // Line padding in string-index space: the region's tree bytes land on
    // string indices first, and the walk then reads real characters even on
    // lines that hold non-ASCII (a byte walk would read mid-codepoint).
    let from = pos().index(region.startIndex);
    while (from > 0 && src[from - 1] !== '\n') from--;
    let to = pos().index(region.endIndex);
    while (to < src.length && src[to] !== '\n') to++;
    const regionText = src.slice(from, to);
    if (!regionText.trim()) continue;
    const rowShift = positionAt(from).row;
    const shift = (r: Range): Range =>
      Range.create(r.start.line + rowShift, r.start.character, r.end.line + rowShift, r.end.character);

    for (const d of declarationsFromSource(regionText)) {
      const range = shift(d.range);
      const key = minedKey(d.name, range);
      if (knownDecl.has(key)) continue;
      knownDecl.add(key);
      declaredNames.push({
        ...d,
        range,
        // The scope the extractors derive is relative to the slice — i.e.
        // to the very structure the damage ate. A wrong NARROW scope is E-2
        // under a new label: a real declaration made invisible by a
        // fabricated boundary reads as an undeclared use. Nothing honest
        // is knowable here, so the name covers the rest of the file — at
        // least as wide as the damage that hid it.
        scope: Range.create(range.start.line, range.start.character, fileEnd.end.line, fileEnd.end.character),
      });
    }
    for (const r0 of routinesFromSource(regionText)) {
      const range = shift(r0.range);
      const key = minedKey(r0.name, range);
      if (knownRoutine.has(key)) continue;
      knownRoutine.add(key);
      routines.push({
        ...r0,
        range,
        declRange: shift(r0.declRange),
        ...(r0.bodyRange ? { bodyRange: shift(r0.bodyRange) } : {}),
      });
    }
    for (const t of bareTargetsFromSource(regionText)) {
      const range = shift(t.range);
      const key = minedKey(t.name, range);
      if (knownTarget.has(key)) continue;
      knownTarget.add(key);
      setTargets.push({ name: t.name, range });
    }
  }

  return {
    declaredNames,
    setTargets,
    syntaxIssues: uniqueIssues,
    modules,
    routines,
    schemas,
    references,
    selectExpressions,
    namespaceAliases,
    errorRegions: damagedRegions.map(toRange),
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

  // Capture positions are byte columns; the quintuples and the line-length
  // clamp must all be in the characters the client counts (positions.ts).
  const p = byteOffsetsFor(source);
  const lineLengths = linesOf(source).map((l) => l.length);
  const tokens: RawToken[] = [];
  for (const cap of captures) {
    const type = TOKEN_TYPE_MAP[cap.name];
    if (!type) continue;
    const s = cap.node.startPosition;
    const e = cap.node.endPosition;
    if (s.row !== e.row) continue; // single-line tokens only
    const start = p.point(s.row, s.column).character;
    const endChar = p.point(e.row, e.column).character;
    const lineLength = lineLengths[s.row];
    const end = lineLength === undefined ? endChar : Math.min(endChar, lineLength);
    if (end <= start) continue;
    tokens.push({ line: s.row, start, end, type });
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

// ─── Clause state for completion (CODE_REVIEW.md C-6) ─────────────────────

/**
 * The clause the cursor sits in, as TEXT: enclosing statement start through
 * the cursor, masked (strings/comments blanked — caller passes `scan()`'s
 * output, offsets are identical) and whitespace-collapsed to single spaces;
 * null when the tree has nothing trustworthy to say.
 *
 * C-6 asked for next-word sets derived from `node-types.json`, but that file
 * carries no next-sibling edges (its entries only have children/extra/fields
 * — verified against the generated file), so the WORDS stay in the shared
 * NEXT_WORD_RULES table and the tree contributes what it actually knows: the
 * CLAUSE STATE. The line-prefix table can only see the cursor's line, so a
 * clause wrapped across lines stops narrowing; this returns the true
 * multi-line prefix, and the collapsed form is exactly the single-line
 * sample the table's patterns were authored against — multi-line and
 * single-line then narrow identically, asserted rule-by-rule in
 * test/completion.test.ts.
 *
 * Each half of the policy is verified against real recoveries (mid-edit
 * buffers routinely have no terminating `;` yet):
 *  - descend to the deepest node starting STRICTLY before the cursor (a node
 *    starting AT the cursor is what comes AFTER it: a cursor resting before
 *    `END IF;` must report the clause before it), then climb to the nearest
 *    `*_statement`; routine/module headers count, since their LANGUAGE /
 *    EXTERNAL NAME clauses are exactly what completes on a next line;
 *  - refuse (null → the caller keeps the line-prefix answer, i.e. today's
 *    behaviour) when an ERROR or MISSING node overlaps the prefix region:
 *    damage BEFORE the cursor means the tree may have read the clause wrong.
 *    Damage at or after the cursor is the normal shape of a statement being
 *    typed and does not poison what precedes it;
 *  - empty prefixes and undamaged-but-headless cursors (offset at or before
 *    the statement's first token) return null: nothing to report.
 */
export function clausePrefixAt(
  tree: Tree,
  maskedText: string,
  offset: number,
  source?: string
): string | null {
  if (offset <= 0) return null;
  // `offset` is a client/UTF-16 offset, `statement.startIndex` a tree byte
  // offset, and `maskedText` a JS string — the third place this document is
  // measured. The byte map must come from the ORIGINAL text (`source`): the
  // mask rewrites non-ASCII comment/string characters to spaces, changing
  // the byte layout the tree's offsets speak.
  const p = byteOffsetsFor(source ?? maskedText);
  const byteOffset = p.byte(offset);
  let node = tree.rootNode;
  descend: while (node.childCount > 0) {
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child.startIndex < byteOffset) {
        node = child;
        continue descend;
      }
    }
    break;
  }
  let statement: SyntaxNode | null = null;
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (n.type.endsWith('_statement')) {
      statement = n;
      break;
    }
  }
  if (!statement || byteOffset <= statement.startIndex) return null;
  if (hasDamageBetween(tree.rootNode, statement.startIndex, byteOffset)) return null;
  const collapsed = maskedText
    .slice(p.index(statement.startIndex), offset)
    .replace(/\s+/g, ' ');
  return collapsed === '' ? null : collapsed;
}

/** True when an ERROR node or a zero-width MISSING repair overlaps [start, end). */
function hasDamageBetween(node: SyntaxNode, start: number, end: number): boolean {
  if (node.startIndex >= end || node.endIndex <= start) return false;
  if (node.type === 'ERROR' || node.isMissing) return true;
  return node.children.some((child) => hasDamageBetween(child, start, end));
}
