/**
 * esql-lsp — ESQL language server for IBM App Connect Enterprise (ACE) / IIB.
 *
 * Speaks LSP over stdio. Consumers: Neovim (vim.lsp.start), OpenCode
 * (`lsp` section in opencode.json), and any other LSP client.
 *
 * Phase 1 capabilities:
 *   - diagnostics (6 heuristic checks, see src/diagnostics.ts)
 *   - completion (keywords, ~70 built-in functions, message tree vars,
 *     types, parser domains, declared variables, 43 snippets)
 *   - hover (function / tree var / domain / type documentation)
 *   - document symbols (namespaces, modules, functions, variables)
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
      diagnostics = analyze(doc.getText(), settings.diagnostics);
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
    },
  };
});

connection.onNotification('initialized', () => {
  // Re-validate any document already open (some clients open before initialized).
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
  return buildCompletionItems(context, linePrefix, doc.getText());
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

connection.onExit(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

textDocuments.listen(connection);
connection.listen();
