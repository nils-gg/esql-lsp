/**
 * esql-lsp — ESQL language server for IBM App Connect Enterprise (ACE) / IIB.
 *
 * Speaks LSP over stdio. Consumers: Neovim (vim.lsp.start), OpenCode
 * (`lsp` section in opencode.json), and any other LSP client.
 *
 * Phase 1 capabilities:
 *   - diagnostics — 6 check functions emitting 7 finding kinds
 *     (see src/diagnostics.ts)
 *   - completion (keywords, ~70 built-in functions, message tree vars,
 *     types, parser domains, declared variables, 43 snippets)
 *   - hover (function / tree var / domain / type documentation)
 *   - document symbols (namespaces, modules, functions, variables)
 *
 * Phase 2 (tree-sitter grammar, loaded lazily & optionally — the server
 * degrades to the heuristics above when the native grammar cannot load):
 *   - grammar-backed syntax errors (ERROR/MISSING nodes)
 *   - parse-tree exact undeclared-variable detection
 *   - semantic tokens for highlighting, driven by the grammar's
 *     queries/highlights.scm
 *   - document symbols, go-to-definition and find-references from the parse
 *     tree (variables, parameters, routines, module names), each with a
 *     pattern-based fallback so heuristic mode keeps working
 */

import {
  createConnection,
  TextDocuments,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionParams,
  CompletionItem,
  HoverParams,
  Hover,
  DocumentSymbolParams,
  DocumentSymbol,
  DefinitionParams,
  ReferenceParams,
  Location,
  Diagnostic,
  Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { analyze } from './diagnostics';
import { buildCompletionItems, detectCompletionContext } from './completion';
import { hoverAt } from './hover';
import { documentSymbols, documentSymbolsFromTree } from './symbols';
import { definitionAt, referencesAt, declarationsFromSource } from './definitions';
import { mergeSettings, EsqlSettings, DEFAULT_SETTINGS } from './settings';
import {
  initGrammar,
  parse,
  analyzeDocument,
  semanticTokensForTree,
  SEMANTIC_TOKEN_TYPES,
  DocAnalysis,
  Tree,
} from './parser';

const DIAGNOSTICS_DEBOUNCE_MS = 300;

// Bind explicitly to stdio so clients can launch the server with no
// command-line arguments (both Neovim and OpenCode do).
const connection = createConnection(process.stdin, process.stdout);
const textDocuments = new TextDocuments<TextDocument>(TextDocument);

let settings: EsqlSettings = DEFAULT_SETTINGS;

/**
 * Pending validation timers, one per document. This MUST be keyed by URI: with
 * a single shared timer, every scheduleDiagnostics() call cancelled the
 * previous document's timer, so a burst of didOpen (restore session, open a
 * folder, restart the server) validated only the last document opened and every
 * other open document never received diagnostics at all. See ISSUES.md I-1.
 */
const debounceTimers = new Map<string, NodeJS.Timeout>();

/**
 * One-entry parse cache. Every request re-reads the whole document, and the
 * features that need semantics (symbols, definitions, references, completion,
 * hover, diagnostics) would otherwise parse the same text several times in a
 * row; text identity is the invalidation key.
 */
interface ParsedDocument {
  text: string;
  tree: Tree | null;
  analysis: DocAnalysis | null;
}

let cachedParse: ParsedDocument | undefined;

function parsedDocument(text: string): ParsedDocument {
  if (cachedParse && cachedParse.text === text) return cachedParse;
  const tree = parse(text);
  cachedParse = { text, tree, analysis: tree ? analyzeDocument(tree) : null };
  return cachedParse;
}

/** Compute and publish diagnostics for one document, right now. */
function publishDiagnosticsFor(uri: string): void {
  const doc = textDocuments.get(uri);
  if (!doc) return;
  let diagnostics: Diagnostic[] = [];
  try {
    const text = doc.getText();
    const { analysis } = parsedDocument(text);
    diagnostics = analyze(text, settings.diagnostics, analysis ?? undefined);
  } catch (err) {
    connection.console.error(`esql-lsp: analysis failed: ${String(err)}`);
  }
  connection.sendDiagnostics({ uri, diagnostics });
}

/** Debounced validation for one document; only re-arms that document's timer. */
function scheduleDiagnostics(uri: string): void {
  const pending = debounceTimers.get(uri);
  if (pending) clearTimeout(pending);
  debounceTimers.set(
    uri,
    setTimeout(() => {
      debounceTimers.delete(uri);
      publishDiagnosticsFor(uri);
    }, DIAGNOSTICS_DEBOUNCE_MS)
  );
}

function cancelScheduledDiagnostics(uri: string): void {
  const pending = debounceTimers.get(uri);
  if (pending) {
    clearTimeout(pending);
    debounceTimers.delete(uri);
  }
}

/**
 * Re-validate every open document. Each document gets its own timer, so a
 * burst of documents opened together all end up published — the loops that
 * call this (initialized, settings change, grammar-ready) are exactly where a
 * single shared timer used to swallow all but the last one.
 */
function revalidateAll(): void {
  for (const doc of textDocuments.all()) {
    scheduleDiagnostics(doc.uri);
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  settings = mergeSettings(params.initializationOptions);
  connection.console.info(
    `esql-lsp: initialized (diagnostics: ${settings.diagnostics.enabled ? 'on' : 'off'})`
  );
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: true,
      },
      completionProvider: {
        triggerCharacters: ['.', ' ', '('],
        resolveProvider: false,
      },
      hoverProvider: true,
      documentSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      // Advertised even before the grammar finishes loading; the handler
      // returns empty results until then, and a refresh is requested once
      // the grammar is ready (if the client supports it).
      semanticTokensProvider: {
        legend: { tokenTypes: SEMANTIC_TOKEN_TYPES, tokenModifiers: [] },
        full: true,
      },
    },
  };
});

connection.onNotification('initialized', () => {
  // Re-validate any document already open (some clients open before initialized).
  revalidateAll();
});

// Runtime settings updates (push-style). Clients send either the section
// keyed by its name ({ esql: {...} }) or the settings object itself; merge
// over the defaults and re-validate every open document.
connection.onDidChangeConfiguration((change) => {
  const raw = change.settings as Record<string, unknown> | undefined;
  const esql = raw && typeof raw.esql === 'object' ? raw.esql : raw;
  settings = mergeSettings(esql);
  connection.console.info('esql-lsp: settings updated (didChangeConfiguration)');
  revalidateAll();
});

textDocuments.onDidOpen((e) => scheduleDiagnostics(e.document.uri));
textDocuments.onDidChangeContent((e) => scheduleDiagnostics(e.document.uri));
textDocuments.onDidClose((e) => {
  cancelScheduledDiagnostics(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  if (!settings.completion.enabled) return [];
  const doc = textDocuments.get(params.textDocument.uri);
  if (!doc) return [];

  const pos = params.position;
  if (pos.line < 0 || pos.line >= doc.lineCount) return [];
  const lineText = doc
    .getText(Range.create(pos.line, 0, pos.line + 1, 0))
    .replace(/\r?\n$/, '');
  const linePrefix = lineText.substring(0, Math.max(0, Math.min(pos.character, lineText.length)));

  const context = detectCompletionContext(linePrefix);
  // Exact declared names/parameters from the parse tree when available; the
  // pattern fallback from definitions.ts keeps them offered without it.
  const text = doc.getText();
  const analysis = parsedDocument(text).analysis;
  const declarations = analysis ? analysis.declaredNames : declarationsFromSource(text);
  return buildCompletionItems(context, linePrefix, text, declarations);
});

connection.onHover((params: HoverParams): Hover | null => {
  const doc = textDocuments.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  return hoverAt(
    text,
    params.position.line,
    params.position.character,
    parsedDocument(text).analysis ?? undefined
  );
});

connection.onDocumentSymbol(
  (params: DocumentSymbolParams): DocumentSymbol[] | null => {
    const doc = textDocuments.get(params.textDocument.uri);
    if (!doc) return null;
    const text = doc.getText();
    const analysis = parsedDocument(text).analysis;
    return analysis ? documentSymbolsFromTree(analysis) : documentSymbols(text);
  }
);

connection.onDefinition((params: DefinitionParams): Location[] | null => {
  const doc = textDocuments.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const ranges = definitionAt(
    text,
    params.position.line,
    params.position.character,
    parsedDocument(text).analysis ?? undefined
  );
  return ranges.length ? ranges.map((range) => Location.create(doc.uri, range)) : null;
});

connection.onReferences((params: ReferenceParams): Location[] | null => {
  const doc = textDocuments.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const includeDeclaration = params.context?.includeDeclaration !== false;
  const ranges = referencesAt(
    text,
    params.position.line,
    params.position.character,
    includeDeclaration,
    parsedDocument(text).analysis ?? undefined
  );
  return ranges.length ? ranges.map((range) => Location.create(doc.uri, range)) : null;
});

connection.languages.semanticTokens.on((params) => {
  const doc = textDocuments.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  const { tree } = parsedDocument(doc.getText());
  if (!tree) return { data: [] };
  return { data: semanticTokensForTree(tree) ?? [] };
});

connection.onExit(() => {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
});

// Load the grammar asynchronously so the server answers requests
// immediately; re-validate open documents and refresh semantic tokens once
// it is ready. Failure here is logged, never fatal (heuristics remain).
initGrammar().then((ok) => {
  connection.console.info(
    ok
      ? 'esql-lsp: tree-sitter grammar loaded — grammar syntax errors + semantic tokens active'
      : 'esql-lsp: tree-sitter grammar unavailable — heuristic mode only'
  );
  if (ok) {
    revalidateAll();
    try {
      // No-op-safe when the client did not declare refresh support.
      connection.languages.semanticTokens.refresh();
    } catch {
      /* tokens still update on every edit */
    }
  }
});

textDocuments.listen(connection);
connection.listen();
