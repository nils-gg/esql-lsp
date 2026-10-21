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
  Diagnostic,
  Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { analyze } from './diagnostics';
import { buildCompletionItems, detectCompletionContext } from './completion';
import { hoverAt } from './hover';
import { documentSymbols } from './symbols';
import { mergeSettings, EsqlSettings, DEFAULT_SETTINGS } from './settings';
import {
  initGrammar,
  parse,
  analyzeDocument,
  semanticTokensForTree,
  SEMANTIC_TOKEN_TYPES,
} from './parser';

const DIAGNOSTICS_DEBOUNCE_MS = 300;

// Bind explicitly to stdio so clients can launch the server with no
// command-line arguments (both Neovim and OpenCode do).
const connection = createConnection(process.stdin, process.stdout);
const textDocuments = new TextDocuments<TextDocument>(TextDocument);

let settings: EsqlSettings = DEFAULT_SETTINGS;

let debounceTimer: NodeJS.Timeout | undefined;

function scheduleDiagnostics(uri: string): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const doc = textDocuments.get(uri);
    if (!doc) return;
    let diagnostics: Diagnostic[] = [];
    try {
      const text = doc.getText();
      const tree = parse(text);
      const docAnalysis = tree ? analyzeDocument(tree) : undefined;
      diagnostics = analyze(text, settings.diagnostics, docAnalysis);
    } catch (err) {
      connection.console.error(`esql-lsp: analysis failed: ${String(err)}`);
    }
    connection.sendDiagnostics({ uri, diagnostics });
  }, DIAGNOSTICS_DEBOUNCE_MS);
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  settings = mergeSettings(params.initializationOptions);
  connection.console.info(
    `esql-lsp: initialized (diagnostics: ${settings.diagnostics.enabled ? 'on' : 'off'})`
  );
  return {
    capabilities: {
      textDocumentSync: {
        change: TextDocumentSyncKind.Incremental,
        save: true,
      },
      completionProvider: {
        triggerCharacters: ['.', ' ', '('],
        resolveProvider: false,
      },
      hoverProvider: true,
      documentSymbolProvider: true,
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
  for (const doc of textDocuments.all()) {
    scheduleDiagnostics(doc.uri);
  }
});

// Runtime settings updates (push-style). Clients send either the section
// keyed by its name ({ esql: {...} }) or the settings object itself; merge
// over the defaults and re-validate every open document.
connection.onDidChangeConfiguration((change) => {
  const raw = change.settings as Record<string, unknown> | undefined;
  const esql = raw && typeof raw.esql === 'object' ? raw.esql : raw;
  settings = mergeSettings(esql);
  connection.console.info('esql-lsp: settings updated (didChangeConfiguration)');
  for (const doc of textDocuments.all()) {
    scheduleDiagnostics(doc.uri);
  }
});

textDocuments.onDidOpen((e) => scheduleDiagnostics(e.document.uri));
textDocuments.onDidChangeContent((e) => scheduleDiagnostics(e.document.uri));
textDocuments.onDidClose((e) => {
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
  // Exact declared names/parameters from the parse tree when available.
  const tree = parse(doc.getText());
  const declarations = tree ? analyzeDocument(tree).declaredNames : undefined;
  return buildCompletionItems(context, linePrefix, doc.getText(), declarations);
});

connection.onHover((params: HoverParams): Hover | null => {
  const doc = textDocuments.get(params.textDocument.uri);
  if (!doc) return null;
  return hoverAt(doc.getText(), params.position.line, params.position.character);
});

connection.onDocumentSymbol(
  (params: DocumentSymbolParams): DocumentSymbol[] | null => {
    const doc = textDocuments.get(params.textDocument.uri);
    if (!doc) return null;
    return documentSymbols(doc.getText());
  }
);

connection.languages.semanticTokens.on((params) => {
  const doc = textDocuments.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  const tree = parse(doc.getText());
  if (!tree) return { data: [] };
  return { data: semanticTokensForTree(tree) ?? [] };
});

connection.onExit(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
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
    for (const doc of textDocuments.all()) {
      scheduleDiagnostics(doc.uri);
    }
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
