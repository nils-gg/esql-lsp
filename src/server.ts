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
  MarkupKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { analyze } from './diagnostics';
import { buildCompletionItems, detectCompletionContext } from './completion';
import { hoverAt } from './hover';
import { documentSymbols, documentSymbolsFromTree } from './symbols';
import {
  definitionAt,
  referencesAt,
  declarationsFromSource,
  routinesFromSource,
  occurrences,
  wordAtPosition,
} from './definitions';
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
import { linesOf, scan } from './scanner';
import { WorkspaceIndex, extractFileFacts, WorkspaceSymbol, SharedVarFact } from './workspaceIndex';
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
 * The workspace's located facts (CODE_REVIEW.md N-2), seen as: the bounded
 * disk snapshot, with every OPEN document's contribution taken from its live
 * text instead of the snapshot — an unsaved `DECLARE x SHARED …` in a sibling
 * buffer counts (at ITS edited position), a deleted one stops counting.
 * Returns undefined without a workspace root: features then behave exactly
 * file-locally, which is what every unit test (and rootUri-less session) gets.
 *
 * This is THE merge: the I-13 name set, the cross-file definition/hover
 * lookups (task 6) and rename (task 16) all read the same view, so they can
 * never disagree about what the workspace declares.
 */
/**
 * `extractFileFacts` for an OPEN document, memoized by text identity the way
 * `parsedDocument` memoizes parses (ISSUES.md I-20's lesson). Without this,
 * every completion keystroke would re-scan every open buffer: validation was
 * debounced, completion is not. Cleared with the parse cache on `didClose`.
 */
const liveFactsCache = new Map<string, { text: string; facts: ReturnType<typeof extractFileFacts> }>();

function liveFacts(doc: TextDocument): ReturnType<typeof extractFileFacts> {
  const text = doc.getText();
  const hit = liveFactsCache.get(doc.uri);
  if (hit && hit.text === text) return hit.facts;
  const facts = extractFileFacts(text, doc.uri);
  liveFactsCache.set(doc.uri, { text, facts });
  return facts;
}

/**
 * An index symbol's stored detail (`'FUNCTION RETURNS BOOLEAN'`, `'PROCEDURE'`)
 * rendered as a readable signature. Shared by cross-file hover and completion
 * so both spell a sibling routine identically.
 */
function workspaceRoutineSig(s: WorkspaceSymbol): string {
  return s.detail.startsWith('FUNCTION')
    ? s.detail.replace(/^FUNCTION\b/, `FUNCTION ${s.name}()`)
    : `${s.detail} ${s.name}()`;
}

function workspaceFacts(): { sharedVars: SharedVarFact[]; routines: WorkspaceSymbol[] } | undefined {
  if (!workspaceIndex.rootPath()) return undefined;
  const sharedVars: SharedVarFact[] = [];
  const routines: WorkspaceSymbol[] = [];
  const openUris = new Set<string>();
  for (const doc of textDocuments.all()) {
    openUris.add(doc.uri);
    const facts = liveFacts(doc);
    sharedVars.push(...facts.sharedVars);
    for (const s of facts.symbols) if (s.kind === 'routine') routines.push(s);
  }
  sharedVars.push(...workspaceIndex.sharedVarsFromDisk(openUris));
  routines.push(...workspaceIndex.symbolsFromDisk(openUris).filter((s) => s.kind === 'routine'));
  return { sharedVars, routines };
}

/** Case-insensitive (ESQL semantics), live buffers first: closest edit wins. */
function lookupSharedVar(name: string): SharedVarFact[] {
  const facts = workspaceFacts();
  if (!facts) return [];
  const key = name.toUpperCase();
  return facts.sharedVars.filter((v) => v.name.toUpperCase() === key);
}

/** Same contract as `lookupSharedVar`, over `CREATE FUNCTION|PROCEDURE`. */
function lookupRoutine(name: string): WorkspaceSymbol[] {
  const facts = workspaceFacts();
  if (!facts) return [];
  const key = name.toUpperCase();
  return facts.routines.filter((s) => s.name.toUpperCase() === key);
}

/**
 * The workspace's SHARED declarations (ISSUES.md I-13) — names only, derived
 * from the one merged view above. Returns undefined without a workspace root:
 * the undeclared check then keeps its file-local meaning.
 */
function sharedNamesFromWorkspace(): ReadonlySet<string> | undefined {
  const facts = workspaceFacts();
  if (!facts) return undefined;
  return new Set(facts.sharedVars.map((v) => v.name.toUpperCase()));
}

/**
 * The workspace's routine names as written (live buffers first, then the
 * on-disk index) — the allow list for the `unknown-routine` check
 * (CODE_REVIEW.md E-4). Returns undefined when the workspace cannot answer
 * honestly: no root (nothing to say, I-13's rule), or the index SKIPPED a
 * file — a routine may be declared there, and a false "not defined" is
 * exactly the deploy-time lie this check exists to prevent.
 */
function routineNamesFromWorkspace(): ReadonlySet<string> | undefined {
  if (!workspaceIndex.rootPath()) return undefined;
  if (workspaceIndex.stats().skipped > 0) return undefined;
  const facts = workspaceFacts();
  if (!facts) return undefined;
  return new Set(facts.routines.map((s) => s.name));
}

/** The word under the cursor exactly as the extractors see it (masked, quoted-aware). */
function cursorWord(text: string, line: number, character: number): string | null {
  const { lines, rawLines } = scan(text);
  const at = wordAtPosition(lines, rawLines, line, character);
  return at ? at.word : null;
}

/** `file:///x/helper.esql` → `helper.esql` — the hover's human location line. */
function baseName(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

/**
 * Cross-file go-to-definition (CODE_REVIEW.md G-1): a `CALL` into a sibling
 * routine or a SHARED variable declared in a sibling file resolved to nothing
 * — definitions were single-file by construction. Only consulted when the
 * document itself answered NOTHING, so a same-file declaration shadows the
 * workspace exactly like a same-scope ESQL declaration shadows a SHARED one.
 */
function workspaceDefinition(word: string, fromUri: string): Location[] {
  const out: Location[] = [];
  for (const r of lookupRoutine(word)) {
    if (r.uri !== fromUri) out.push(Location.create(r.uri, r.range));
  }
  for (const v of lookupSharedVar(word)) {
    if (v.uri !== fromUri) out.push(Location.create(v.uri, v.range));
  }
  return out;
}

/**
 * Cross-file hover (CODE_REVIEW.md G-2): the signature is synthesized from
 * the located facts — the hover promises what the index actually knows. The
 * `workspace —` prefix marks the path taken (the plan's assertion hook).
 */
function workspaceHover(word: string, fromUri: string): Hover | null {
  const md = (code: string, where: string): Hover => ({
    contents: {
      kind: MarkupKind.Markdown,
      value: '```esql\n' + code + '\n```\n\n*workspace — ' + where + '*',
    },
  });
  for (const r of lookupRoutine(word)) {
    if (r.uri === fromUri) continue;
    return md(
      workspaceRoutineSig(r),
      `defined in ${baseName(r.uri)}${r.container ? ` (module ${r.container})` : ''}`
    );
  }
  for (const v of lookupSharedVar(word)) {
    if (v.uri === fromUri) continue;
    return md(`DECLARE ${v.name} SHARED;`, `defined in ${baseName(v.uri)} (${v.detail})`);
  }
  return null;
}

/** Range equality, the way this file needs to compare fact ranges. */
function sameRange(a: Range, b: Range): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

/**
 * Cross-file references (CODE_REVIEW.md G-3). Two halves:
 *  - in-file: a SHARED name declared in a SIBLING has no local declaration,
 *    so `referencesAt` answered zero — the current file's own occurrences are
 *    then reported through the same whole-word finder the in-file path uses.
 *  - cross-file: every file that shares the name (declares it, by the located
 *    facts) is scanned — open buffers from live text, disk files from the
 *    snapshot text. Workspace ≈ application is the documented approximation
 *    (review N-2). A ROUTINE name that resolves inside the current file keeps
 *    its answer file-local (`Main` in ten files means ten different
 *    routines); SHARED names are application-wide by definition, so they
 *    always get the full sweep.
 */
function crossFileReferences(
  word: string,
  fromUri: string,
  localRanges: Range[],
  includeDeclaration: boolean
): Location[] {
  const vars = lookupSharedVar(word).filter((v) => v.uri !== fromUri);
  const routines = lookupRoutine(word).filter((r) => r.uri !== fromUri);
  if (vars.length === 0 && routines.length === 0) return [];
  // A ROUTINE answered by the file itself stays file-local (local shadow,
  // same rule as definition); a SHARED name always sweeps the workspace.
  const localRoutineAnswer = routines.length > 0 && vars.length === 0 && localRanges.length > 0;
  if (localRoutineAnswer) return [];

  const out: Location[] = [];
  const seen = new Set<string>();
  const add = (uri: string, ranges: Range[]) => {
    for (const r of ranges) {
      const key = `${uri}|${r.start.line}:${r.start.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(Location.create(uri, r));
    }
  };

  // The current file's own occurrences — its half of G-3 when the name is
  // declared in a sibling and referencesAt had nothing to resolve.
  const here = textDocuments.get(fromUri);
  if (here) add(fromUri, occurrences(here.getText(), word));

  for (const doc of textDocuments.all()) {
    if (doc.uri === fromUri) continue;
    const sharedHere =
      vars.some((v) => v.uri === doc.uri) || routines.some((r) => r.uri === doc.uri);
    if (sharedHere) add(doc.uri, occurrences(doc.getText(), word));
  }
  const openUris = new Set(textDocuments.keys());
  for (const facts of workspaceIndex.factsFromDisk(openUris)) {
    const sharedHere =
      vars.some((v) => v.uri === facts.uri) || routines.some((r) => r.uri === facts.uri);
    if (sharedHere) add(facts.uri, occurrences(facts.text, word));
  }
  if (includeDeclaration) {
    // The declaration NAME itself: inside scan-able text it is already among
    // the occurrences; this also catches names the word finder cannot spell
    // (quoted names). The shared `seen` key keeps it idempotent.
    for (const v of vars) add(v.uri, [v.range]);
    for (const r of routines) add(r.uri, [r.range]);
    return out;
  }
  return out.filter(
    (l) =>
      !vars.some((v) => v.uri === l.uri && sameRange(v.range, l.range)) &&
      !routines.some((r) => r.uri === l.uri && sameRange(r.range, l.range))
  );
}

/** Compute and publish diagnostics for one document, right now. */
function publishDiagnosticsFor(uri: string): void {
  const doc = textDocuments.get(uri);
  if (!doc) return;
  let diagnostics: Diagnostic[] = [];
  try {
    const text = doc.getText();
    const { analysis } = parsedDocument(uri, text);
    diagnostics = analyze(
      text,
      settings.diagnostics,
      analysis ?? undefined,
      sharedNamesFromWorkspace(),
      routineNamesFromWorkspace()
    );
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
  liveFactsCache.delete(e.document.uri);
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
  // C-1/C-2: the file's own routines plus the workspace's sibling routines and
  // SHARED names. The current file's entries are EXCLUDED — its own
  // declarations are already in the list (and win the dedupe) — and every
  // sibling name carries its file's base name for the detail line.
  const ws = workspaceFacts();
  const completionFacts = {
    routines: analysis ? analysis.routines : routinesFromSource(text),
    sharedVars: (ws?.sharedVars ?? [])
      .filter((v) => v.uri !== doc.uri)
      .map((v) => ({ name: v.name, detail: v.detail, file: baseName(v.uri) })),
    workspaceRoutines: (ws?.routines ?? [])
      .filter((r) => r.uri !== doc.uri)
      .map((r) => ({ name: r.name, detail: workspaceRoutineSig(r), file: baseName(r.uri) })),
  };
  // The cursor position is what makes the declared-name list scope-correct.
  return buildCompletionItems(context, linePrefix, text, declarations, {
    line: pos.line,
    character: pos.character,
  }, clientWantsSnippets, completionFacts);
});

connection.onHover((params: HoverParams): Hover | null => {
  const doc = documentFor(params);
  if (!doc) return null;
  const position = viewPosition(doc, params.position);
  if (!position) return null;
  const text = doc.getText();
  const local = hoverAt(
    text,
    position.line,
    position.character,
    parsedDocument(doc.uri, text).analysis ?? undefined
  );
  if (local) return local;
  // G-2: hover a CALL target or SHARED name that lives in a sibling file.
  const word = cursorWord(text, position.line, position.character);
  if (!word) return null;
  return workspaceHover(word, doc.uri);
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
  if (ranges.length) return ranges.map((range) => Location.create(doc.uri, range));
  // G-1: nothing in this file — sibling routines and SHARED variables next.
  const word = cursorWord(text, position.line, position.character);
  if (!word) return null;
  const cross = workspaceDefinition(word, doc.uri);
  return cross.length ? cross : null;
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
  const out = ranges.map((range) => Location.create(doc.uri, range));
  // G-3: merge the workspace half (no-op unless the name is SHARED or a
  // routine that lives elsewhere, see crossFileReferences).
  const word = cursorWord(text, position.line, position.character);
  if (word) {
    const local = new Set(out.map((l) => `${l.range.start.line}:${l.range.start.character}`));
    for (const loc of crossFileReferences(word, doc.uri, ranges, includeDeclaration)) {
      const key = `${loc.range.start.line}:${loc.range.start.character}`;
      if (loc.uri !== doc.uri || !local.has(key)) out.push(loc);
    }
  }
  return out.length ? out : null;
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
