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
 *   - workspace symbols (flat outline of the workspace's `.esql` files and
 *     open buffers) and a cross-file-aware undeclared-variable check that
 *     honours SHARED declarations in sibling files (ISSUES.md I-13)
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
  SymbolInformation,
  SymbolKind,
  DefinitionParams,
  ReferenceParams,
  Location,
  Diagnostic,
  Range,
  Position,
  ResponseError,
  ErrorCodes,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { analyze } from './diagnostics';
import { buildCompletionItems, detectCompletionContext } from './completion';
import { hoverAt } from './hover';
import { documentSymbols, documentSymbolsFromTree } from './symbols';
import { definitionAt, referencesAt, declarationsFromSource } from './definitions';
import { mergeSettings, unwrapSettings, EsqlSettings, DEFAULT_SETTINGS } from './settings';
import {
  initGrammar,
  parse,
  analyzeDocument,
  semanticTokensForTree,
  SEMANTIC_TOKEN_TYPES,
  DocAnalysis,
  Tree,
} from './parser';
import { linesOf } from './scanner';
import { WorkspaceIndex, extractFileFacts, WorkspaceSymbol } from './workspaceIndex';
import { fileURLToPath } from 'url';

const DIAGNOSTICS_DEBOUNCE_MS = 300;

// Bind explicitly to stdio so clients can launch the server with no
// command-line arguments (both Neovim and OpenCode do).
const connection = createConnection(process.stdin, process.stdout);
const textDocuments = new TextDocuments<TextDocument>(TextDocument);

let settings: EsqlSettings = DEFAULT_SETTINGS;

/**
 * Cross-file view (ISSUES.md I-13): the bounded `.esql` scan under the
 * client's workspace root, consulted by the undeclared-variable check and
 * `workspace/symbol`. Empty and inert when no root was given.
 */
const workspaceIndex = new WorkspaceIndex();

/**
 * Whether the *client* declared `workspace.semanticTokens.refreshSupport`.
 * Server→client requests are opt-in by capability: sending one to a client that
 * never declared it invites a "method not found" response, and the promise for
 * that request used to be discarded, which made the response an unhandled
 * rejection and killed the process (ISSUES.md I-14). So: never send it unless
 * asked for, and catch it anyway.
 */
let clientWantsSemanticTokensRefresh = false;

/**
 * Whether the *client* asked for hierarchical document symbols. Default false,
 * which is what the protocol says a client without `…documentSymbol.
 * hierarchicalDocumentSymbolSupport` means. This server has always answered
 * `textDocument/documentSymbol` with the nested `DocumentSymbol[]` shape, which
 * a client that never declared the capability reads as one flat list of
 * nameless entries — the outline silently loses everything below module level
 * (ISSUES.md I-22). Serving the shape the client declared costs one flattening
 * pass and makes that client's outline work.
 */
let clientWantsHierarchicalSymbols = false;

/**
 * Whether the *client* declared `completionItem.snippetSupport`. Snippet
 * bodies are LSP snippet strings (`${1:…}`, `${1|a,b|}`, `$0`); the protocol
 * says `insertText` without `insertTextFormat` is PlainText, so sending them
 * raw to a client that never asked for snippets typed placeholder syntax
 * literally into the buffer (CODE_REVIEW.md C-4). Without the capability the
 * server ships de-placeholdered text that is valid ESQL as typed.
 */
let clientWantsSnippets = false;

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

/**
 * Parse results, one entry per open document, dropped when the document closes.
 *
 * There used to be a single slot compared by text, which is fine for one open
 * file and wrong for two: a client cycling two buffers (a `workspace/symbol`
 * sweep, a split view, an extension walking files) missed the slot on every
 * alternating request and re-parsed plus re-walked the whole tree, ~10 ms of
 * analysis per keystroke on a real 370 KB file (ISSUES.md I-20).
 *
 * The text is still compared, because `didChange` is handled by the document
 * model and a request can arrive for a version this server has not parsed yet;
 * the comparison is reference-cheap for an unchanged buffer.
 */
const parseCache = new Map<string, ParsedDocument>();

function parsedDocument(uri: string, text: string): ParsedDocument {
  const hit = parseCache.get(uri);
  if (hit && hit.text === text) return hit;
  const tree = parse(text);
  const entry: ParsedDocument = { text, tree, analysis: tree ? analyzeDocument(tree, text) : null };
  parseCache.set(uri, entry);
  return entry;
}

/**
 * The workspace's SHARED declarations (ISSUES.md I-13), seen as: the bounded
 * disk snapshot, with every OPEN document's contribution taken from its live
 * text instead of the snapshot — an unsaved `DECLARE x SHARED …` in a sibling
 * buffer counts, a deleted one stops counting. Returns undefined without a
 * workspace root: the undeclared check then keeps its file-local meaning,
 * which is what every unit test (and rootUri-less session) gets.
 */
function sharedNamesFromWorkspace(): ReadonlySet<string> | undefined {
  if (!workspaceIndex.rootPath()) return undefined;
  const names = new Set<string>();
  const openUris = new Set<string>();
  for (const doc of textDocuments.all()) {
    openUris.add(doc.uri);
    for (const n of extractFileFacts(doc.getText(), doc.uri).sharedNames) names.add(n);
  }
  for (const n of workspaceIndex.sharedNamesFromDisk(openUris)) names.add(n);
  return names;
}

/** Compute and publish diagnostics for one document, right now. */
function publishDiagnosticsFor(uri: string): void {
  const doc = textDocuments.get(uri);
  if (!doc) return;
  let diagnostics: Diagnostic[] = [];
  try {
    const text = doc.getText();
    const { analysis } = parsedDocument(uri, text);
    diagnostics = analyze(text, settings.diagnostics, analysis ?? undefined, sharedNamesFromWorkspace());
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

/**
 * Whether the grammar loaded. Semantic tokens are only worth asking the client
 * to redo once it has, and the request itself has to wait for the client to
 * finish initializing — see `requestSemanticTokensRefresh`.
 */
let grammarIsReady = false;
/** True from the `initialized` notification on: the client may be asked things. */
let clientIsReady = false;
/** Only ever one refresh per process; more would be editor-visible flicker. */
let refreshSent = false;

/**
 * Ask the client to re-request semantic tokens, once, and only when all three
 * hold: the grammar has landed (the event worth reporting), the client finished
 * initializing (a server→client request before that is out of order), and the
 * client declared `workspace.semanticTokens.refreshSupport` — sending it to a
 * client that never asked used to produce a "method not found" answer whose
 * promise nobody held, and the resulting unhandled rejection ended the process
 * (ISSUES.md I-14).
 *
 * The promise is caught either way. Tokens stay correct without the refresh —
 * every document re-requested after an edit sees the grammar — so a declined or
 * unanswered refresh costs nothing but the initial repaint.
 */
function requestSemanticTokensRefresh(): void {
  if (refreshSent || !grammarIsReady || !clientIsReady) return;
  if (!clientWantsSemanticTokensRefresh) return;
  refreshSent = true;
  Promise.resolve(connection.languages.semanticTokens.refresh()).catch((err) => {
    connection.console.info(
      `esql-lsp: semanticTokens/refresh declined by the client: ${String(err)}`
    );
  });
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  settings = mergeSettings(unwrapSettings(params.initializationOptions));
  clientWantsSemanticTokensRefresh =
    params.capabilities?.workspace?.semanticTokens?.refreshSupport === true;
  clientWantsHierarchicalSymbols =
    params.capabilities?.textDocument?.documentSymbol?.hierarchicalDocumentSymbolSupport === true;
  clientWantsSnippets =
    params.capabilities?.textDocument?.completion?.completionItem?.snippetSupport === true;
  // Workspace root for the I-13 index: `workspaceFolders` is the modern field,
  // `rootUri` the deprecated one — clients that send both agree, so whichever
  // arrives wins. Non-`file:` schemes (a VFS workspace) get no index; every
  // feature then behaves exactly as it did before the index existed.
  const root = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined;
  if (root && /^file:\/\//i.test(root)) {
    try {
      workspaceIndex.setRoot(fileURLToPath(root));
    } catch {
      // A malformed file: URI is indistinguishable from no workspace.
    }
  }
  connection.console.info(
    `esql-lsp: initialized (diagnostics: ${settings.diagnostics.enabled ? 'on' : 'off'})`
  );
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        // No `save`. Diagnostics are produced from didOpen/didChange, so a save
        // notification would only re-publish what the last change already
        // published; advertising it promised a `textDocument/didSave` handler
        // this server does not have (ISSUES.md I-22).
      },
      completionProvider: {
        triggerCharacters: ['.', ' ', '('],
        resolveProvider: false,
      },
      hoverProvider: true,
      documentSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      // Flat outline over the I-13 workspace index plus open buffers (ISSUES.md
      // I-13: cross-file resolution needed this and the shared-name-aware
      // undeclared check; both degrade to "open documents only" without a root).
      workspaceSymbolProvider: true,
      // Advertised even before the grammar finishes loading; the handler
      // returns empty results until then, and a refresh is requested once the
      // grammar is ready — see `clientWantsSemanticTokensRefresh`, which gates
      // that request on the client having asked for it. Advertising it is what
      // makes the request legal, so it is advertised only when we may send it.
      semanticTokensProvider: {
        legend: { tokenTypes: SEMANTIC_TOKEN_TYPES, tokenModifiers: [] },
        full: true,
      },
      workspace: {
        // The bundled ServerCapabilities['workspace'] type predates the
        // semanticTokens section (LSP 3.16), so it needs the cast.
        semanticTokens: { refreshSupport: clientWantsSemanticTokensRefresh },
      } as unknown as NonNullable<InitializeResult['workspace']>,
    },
  };
});

connection.onNotification('initialized', () => {
  // From here on a server→client request is legal; the grammar may well have
  // loaded before this arrived, so this is where the owed refresh actually goes.
  clientIsReady = true;
  requestSemanticTokensRefresh();
  // Re-validate any document already open (some clients open before initialized).
  revalidateAll();
  // The I-13 scan runs after the handshake so it can never block the first
  // answer. When it lands, open documents re-check with the workspace's SHARED
  // names in hand — the moment `FailureCount` stops being reported as
  // undeclared. An open document edited before the scan finishes may flash the
  // false positive first; the rescan re-publishes it away.
  if (workspaceIndex.rootPath()) {
    void workspaceIndex.rescan().then(() => {
      const s = workspaceIndex.stats();
      connection.console.info(
        `esql-lsp: workspace index — ${s.files} .esql files indexed, ${s.skipped} skipped`
      );
      revalidateAll();
    });
  }
});

// Runtime settings updates (push-style). Clients send either the section
// keyed by its name ({ esql: {...} }) or the settings object itself; both are
// unwrapped by the same helper initializationOptions uses, merged over the
// defaults, and every open document is re-validated.
connection.onDidChangeConfiguration((change) => {
  settings = mergeSettings(unwrapSettings(change.settings));
  connection.console.info('esql-lsp: settings updated (didChangeConfiguration)');
  revalidateAll();
});

textDocuments.onDidOpen((e) => scheduleDiagnostics(e.document.uri));
textDocuments.onDidChangeContent((e) => scheduleDiagnostics(e.document.uri));

// workspace/symbol over the I-13 index: open buffers first (their text is
// current), then the disk snapshot; `query` filters as a case-insensitive
// substring, and the count is bounded so a huge workspace cannot make the
// response pathological. Without a workspace root the open buffers alone
// answer — still more than no handler at all.
const MAX_WORKSPACE_SYMBOLS = 2000;
connection.onWorkspaceSymbol((params): SymbolInformation[] => {
  const query = (params.query ?? '').toLowerCase();
  const out: SymbolInformation[] = [];
  const toInfo = (s: WorkspaceSymbol): SymbolInformation => ({
    name: s.name,
    kind: s.kind === 'module' ? SymbolKind.Module : s.kind === 'schema' ? SymbolKind.Namespace : SymbolKind.Function,
    containerName: s.container,
    location: { uri: s.uri, range: s.range },
  });
  const matches = (s: WorkspaceSymbol) => s.name.toLowerCase().includes(query);
  const openUris = new Set<string>();
  for (const doc of textDocuments.all()) {
    openUris.add(doc.uri);
    for (const s of extractFileFacts(doc.getText(), doc.uri).symbols) {
      if (!matches(s)) continue;
      out.push(toInfo(s));
      if (out.length >= MAX_WORKSPACE_SYMBOLS) return out;
    }
  }
  for (const s of workspaceIndex.symbolsFromDisk(openUris)) {
    if (!matches(s)) continue;
    out.push(toInfo(s));
    if (out.length >= MAX_WORKSPACE_SYMBOLS) break;
  }
  return out;
});
textDocuments.onDidClose((e) => {
  parseCache.delete(e.document.uri); // the entry's text would never be asked for again
  cancelScheduledDiagnostics(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

/* ------------------------------------------------------------------ *
 *  Request guards                                                     *
 * ------------------------------------------------------------------ */

/**
 * The document a request is about.
 *
 * `textDocument.uri` is required by the protocol, but clients that proxy or
 * replay requests do send `{}`, and `params.textDocument.uri` then threw a
 * TypeError straight out of the handler: the client received
 * `-32603 InternalError` carrying V8's own words ("Cannot read properties of
 * undefined (reading 'uri')") where the protocol asks for `InvalidParams`
 * (ISSUES.md I-22). A server that answers a bad request with its own internals
 * teaches the editor to show a type error to the user.
 */
function documentFor(params: unknown): TextDocument | undefined {
  const uri = (params as { textDocument?: { uri?: unknown } } | null | undefined)?.textDocument
    ?.uri;
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new ResponseError(
      ErrorCodes.InvalidParams,
      'esql-lsp: request has no textDocument.uri',
      'the request carried no document URI, so there is no document to answer about'
    );
  }
  return textDocuments.get(uri);
}

/**
 * A position the feature code may trust, or `null` for "outside this document".
 *
 * Two different failures, answered differently on purpose. A `position` that is
 * missing or not a pair of non-negative integers is a malformed request and gets
 * `InvalidParams`. A line or column past the end of the text is not: a client
 * whose buffer moved between sending and this handler running is an ordinary
 * race, and the honest reply is "there is nothing at that position" rather than
 * an error the editor pops up. What it must not be is a TypeError from the word
 * readers in hover/completion/definitions, which index the line array directly
 * (ISSUES.md I-22).
 */
function viewPosition(doc: TextDocument, position: unknown): Position | null {
  const line = (position as { line?: unknown } | null | undefined)?.line;
  const character = (position as { character?: unknown } | null | undefined)?.character;
  if (
    typeof line !== 'number' ||
    typeof character !== 'number' ||
    !Number.isInteger(line) ||
    !Number.isInteger(character) ||
    line < 0 ||
    character < 0
  ) {
    throw new ResponseError(
      ErrorCodes.InvalidParams,
      'esql-lsp: request has no usable position',
      `expected a zero-based integer { line, character }, got ${JSON.stringify(position) ?? 'nothing'}`
    );
  }
  // The client's own line split, so "past the end" means the same thing here as
  // it does in the buffer it is looking at.
  const lines = linesOf(doc.getText());
  if (line >= lines.length) return null;
  // One past the last character is where a cursor at end-of-line sits; anything
  // further is not a position this document has.
  if (character > lines[line].length) return null;
  return { line, character };
}

/**
 * `DocumentSymbol[]` in the flat `SymbolInformation[]` shape a client without
 * `hierarchicalDocumentSymbolSupport` asked for. The symbol's own name range
 * becomes its location, and `containerName` carries what the nesting said, so
 * nothing is lost that the flat shape can hold.
 */
function flattenSymbols(
  uri: string,
  symbols: readonly DocumentSymbol[],
  containerName = '',
  into: SymbolInformation[] = []
): SymbolInformation[] {
  for (const symbol of symbols) {
    into.push({
      name: symbol.name,
      kind: symbol.kind,
      tags: symbol.tags,
      containerName,
      location: { uri, range: symbol.selectionRange },
    });
    if (symbol.children) flattenSymbols(uri, symbol.children, symbol.name, into);
  }
  return into;
}

connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  if (!settings.completion.enabled) return [];
  const doc = documentFor(params);
  if (!doc) return [];

  const pos = viewPosition(doc, params.position);
  if (!pos) return [];
  const lineText = doc
    .getText(Range.create(pos.line, 0, pos.line + 1, 0))
    .replace(/\r?\n$/, '');
  const linePrefix = lineText.substring(0, Math.max(0, Math.min(pos.character, lineText.length)));

  const context = detectCompletionContext(linePrefix);
  // Exact declared names/parameters from the parse tree when available; the
  // pattern fallback from definitions.ts keeps them offered without it.
  const text = doc.getText();
  const analysis = parsedDocument(doc.uri, text).analysis;
  const declarations = analysis ? analysis.declaredNames : declarationsFromSource(text);
  // The cursor position is what makes the declared-name list scope-correct.
  return buildCompletionItems(context, linePrefix, text, declarations, {
    line: pos.line,
    character: pos.character,
  }, clientWantsSnippets);
});

connection.onHover((params: HoverParams): Hover | null => {
  const doc = documentFor(params);
  if (!doc) return null;
  const position = viewPosition(doc, params.position);
  if (!position) return null;
  const text = doc.getText();
  return hoverAt(text, position.line, position.character, parsedDocument(doc.uri, text).analysis ?? undefined);
});

connection.onDocumentSymbol(
  (params: DocumentSymbolParams): DocumentSymbol[] | SymbolInformation[] | null => {
    const doc = documentFor(params);
    if (!doc) return null;
    const text = doc.getText();
    const analysis = parsedDocument(doc.uri, text).analysis;
    const symbols = analysis ? documentSymbolsFromTree(analysis) : documentSymbols(text);
    // The nested shape only means anything to a client that asked for it.
    return clientWantsHierarchicalSymbols ? symbols : flattenSymbols(doc.uri, symbols);
  }
);

connection.onDefinition((params: DefinitionParams): Location[] | null => {
  const doc = documentFor(params);
  if (!doc) return null;
  const position = viewPosition(doc, params.position);
  if (!position) return null;
  const text = doc.getText();
  const ranges = definitionAt(
    text,
    position.line,
    position.character,
    parsedDocument(doc.uri, text).analysis ?? undefined
  );
  return ranges.length ? ranges.map((range) => Location.create(doc.uri, range)) : null;
});

connection.onReferences((params: ReferenceParams): Location[] | null => {
  const doc = documentFor(params);
  if (!doc) return null;
  const position = viewPosition(doc, params.position);
  if (!position) return null;
  const text = doc.getText();
  const includeDeclaration = params.context?.includeDeclaration !== false;
  const ranges = referencesAt(
    text,
    position.line,
    position.character,
    includeDeclaration,
    parsedDocument(doc.uri, text).analysis ?? undefined
  );
  return ranges.length ? ranges.map((range) => Location.create(doc.uri, range)) : null;
});

connection.languages.semanticTokens.on((params) => {
  const doc = documentFor(params);
  if (!doc) return { data: [] };
  const text = doc.getText();
  const { tree } = parsedDocument(doc.uri, text);
  if (!tree) return { data: [] };
  return { data: semanticTokensForTree(tree, text) ?? [] };
});

connection.onExit(() => {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
});

// Load the grammar asynchronously so the server answers requests
// immediately; re-validate open documents and refresh semantic tokens once
// it is ready. Failure here is logged, never fatal (heuristics remain).
initGrammar().then(
  (ok) => {
    connection.console.info(
      ok
        ? 'esql-lsp: tree-sitter grammar loaded — grammar syntax errors + semantic tokens active'
        : 'esql-lsp: tree-sitter grammar unavailable — heuristic mode only'
    );
    if (!ok) return;
    grammarIsReady = true;
    revalidateAll();
    requestSemanticTokensRefresh();
  },
  (err) => {
    connection.console.error(`esql-lsp: grammar initialisation rejected: ${String(err)}`);
  }
);

/**
 * Nothing here may take the server down. A rejected promise from a
 * server→client request, or a throw inside an async handler, used to end the
 * process (`ResponseError: Unhandled method workspace/semanticTokens/refresh`
 * → exit 1, ~0.2 s after start, in grammar mode — ISSUES.md I-14), and a dead
 * server is worse than any single wrong answer it could produce. Log and live;
 * the individual call sites are still expected to handle their own failures.
 */
process.on('unhandledRejection', (reason) => {
  connection.console.error(`esql-lsp: ignored unhandled rejection: ${String(reason)}`);
});
process.on('uncaughtException', (err) => {
  connection.console.error(`esql-lsp: ignored uncaught exception: ${String(err)}`);
});

textDocuments.listen(connection);
connection.listen();
