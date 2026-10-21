/**
 * tree-sitter integration (Phase 2).
 *
 * Lazily loads the `tree-sitter` runtime and the `tree-sitter-esql` grammar
 * and exposes parse-tree derived facts to the analyzer: declared names,
 * bare-SET targets, syntax errors and semantic tokens (from the grammar's
 * queries/highlights.scm).
 *
 * Graceful degradation is a hard requirement: if the native binding cannot
 * load (missing build toolchain, unsupported platform, npm install without
 * scripts), `grammarReady()` stays false and every caller falls back to the
 * Phase 1 regex heuristics. The server must never crash because of this
 * module.
 */

import { Range } from 'vscode-languageserver';

/** Minimal structural view of a tree-sitter node (avoids pulling the
 *  runtime's types into the server's compile). */
export interface SyntaxNode {
  type: string;
  text: string;
  childCount: number;
  children: SyntaxNode[];
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  hasError: boolean;
  isMissing?: boolean;
}

export interface Tree {
  rootNode: SyntaxNode;
}

export interface DeclaredName {
  name: string;
  /** Human-readable type for completion details, e.g. 'INTEGER'. */
  detail: string;
  range: Range;
}

export interface SetTarget {
  name: string;
  range: Range;
}

export interface SyntaxIssue {
  message: string;
  range: Range;
}

export interface DocAnalysis {
  declaredNames: DeclaredName[];
  setTargets: SetTarget[];
  syntaxIssues: SyntaxIssue[];
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

async function doInit(): Promise<boolean> {
  try {
    // Lazy require inside try/catch: a broken native build must degrade,
    // not kill the server at import time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('tree-sitter');
    const ParserClass = mod.default ?? mod;

    const esql = await trueDynamicImport('tree-sitter-esql');
    runtimeLanguage = esql.default ?? esql;

    runtimeParser = new ParserClass();
    runtimeParser.setLanguage(runtimeLanguage);

    // Highlight queries live next to the grammar package.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const pkgDir = path.dirname(require.resolve('tree-sitter-esql/package.json'));
    const scm = fs.readFileSync(path.join(pkgDir, 'queries', 'highlights.scm'), 'utf8');
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

/** Parse a document; null when the grammar is unavailable or parsing fails. */
export function parse(text: string): Tree | null {
  if (!grammarReady()) return null;
  try {
    return runtimeParser.parse(text) as Tree;
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

/**
 * Extract everything the analyzers need from a parse tree in one walk:
 * declared names (DECLARE name lists + routine parameters), bare-word SET
 * targets, and syntax errors (outermost ERROR regions plus silently
 * inserted tokens — see isInsertedNode).
 */

/**
 * Tree-sitter's cheap error recovery repairs e.g. a missing `;` between
 * otherwise clean statements by INSERTING the token: it shows up as a
 * zero-width, empty-text leaf node typed after the expected token, without
 * any MISSING marker in the npm binding. Real nodes always have text, so
 * this pattern can only be an insertion.
 */
function isInsertedNode(node: SyntaxNode): boolean {
  return node.childCount === 0 && node.text === '';
}

export function analyzeDocument(tree: Tree): DocAnalysis {
  const declaredNames: DeclaredName[] = [];
  const setTargets: SetTarget[] = [];
  const syntaxIssues: SyntaxIssue[] = [];

  const visit = (node: SyntaxNode): void => {
    if (node.type === 'ERROR' || node.type === 'MISSING' || node.isMissing || isInsertedNode(node)) {
      syntaxIssues.push({
        message: isInsertedNode(node)
          ? `Missing syntax: expected '${node.type}' here.`
          : 'Syntax error.',
        range: rangeOf(node),
      });
      // Error recovery preserves intact subtrees inside the damaged region
      // (e.g. a complete CREATE FUNCTION inside a module missing its
      // END MODULE). Mine those for semantics, but never descend through
      // another broken node — and skip insertion markers, which would
      // re-report positions already covered by the outer error.
      for (const child of node.children) {
        if (!child.hasError && !isInsertedNode(child)) visit(child);
      }
      return;
    }

    switch (node.type) {
      case 'declare_statement': {
        // Direct identifier children are the declared names — a multi-name
        // `DECLARE a, b TYPE` declares every one of them. Handlers are a
        // separate node type (declare_handler_statement) and never land
        // here. The REFERENCE TO target is a field_reference child, not an
        // identifier, so it is not mistaken for a declaration.
        const typeNode = node.children.find((c) => c.type === 'datatype');
        const constant = node.children.some((c) => c.type === 'kw_CONSTANT') ? 'CONSTANT ' : '';
        const detail = constant + (typeNode ? typeNode.text.toUpperCase() : '');
        for (const child of node.children) {
          if (child.type === 'identifier') {
            declaredNames.push({ name: child.text, detail, range: rangeOf(child) });
          }
        }
        break; // keep descending: a recovered missing ';' lives in here
      }
      case 'routine_parameter': {
        // One identifier child: the parameter name.
        for (const child of node.children) {
          if (child.type === 'identifier') {
            declaredNames.push({ name: child.text, detail: 'parameter', range: rangeOf(child) });
          }
        }
        break; // keep descending for recovered missing tokens
      }
      case 'set_statement': {
        const target = node.children.find((c) => c.type === 'field_reference');
        if (target && target.childCount === 1) {
          const only = target.children[0];
          if (only.type === 'identifier') {
            // Bare `SET x = …` (not a message-tree path like `SET a.b = …`).
            setTargets.push({ name: only.text, range: rangeOf(only) });
          }
        }
        break; // descend (harmless: SET contains no nested statements)
      }
    }

    for (const child of node.children) visit(child);
  };

  visit(tree.rootNode);
  return { declaredNames, setTargets, syntaxIssues };
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
 */
export function semanticTokensForTree(tree: Tree): number[] | null {
  if (!highlightsQuery) return null;
  let captures: Array<{ name: string; node: SyntaxNode }>;
  try {
    captures = highlightsQuery.captures(tree.rootNode);
  } catch {
    return null;
  }

  const tokens: RawToken[] = [];
  for (const cap of captures) {
    const type = TOKEN_TYPE_MAP[cap.name];
    if (!type) continue;
    const s = cap.node.startPosition;
    const e = cap.node.endPosition;
    if (s.row !== e.row) continue; // single-line tokens only
    if (e.column <= s.column) continue;
    tokens.push({ line: s.row, start: s.column, end: e.column, type });
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
