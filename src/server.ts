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
  RenameParams,
  PrepareRenameParams,
  WorkspaceEdit,
  Diagnostic,
  Range,
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  Position,
  ResponseError,
  ErrorCodes,
  MarkupKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { analyze } from './diagnostics';
import { buildCodeActions } from './codeActions';
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
  modulesFromSource,
  schemaFromSource,
} from './definitions';
import { mergeSettings, unwrapSettings, EsqlSettings, DEFAULT_SETTINGS } from './settings';
import {
  initGrammar,
  parse,
  clausePrefixAt,
  analyzeDocument,
  semanticTokensForTree,
  SEMANTIC_TOKEN_TYPES,
  DocAnalysis,
  Tree,
} from './parser';
import { linesOf, scan } from './scanner';
import { WorkspaceIndex, extractFileFacts, WorkspaceSymbol, SharedVarFact } from './workspaceIndex';
import * as fs from 'fs';
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
/** Whether the client accepts `documentChanges` in a WorkspaceEdit (rename
* needs it for per-edit change annotations; `changes` stays the fallback). */
let clientSupportsDocumentChanges = false;

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
 * Every whole-word occurrence of `name` in EVERY file the workspace can see —
 * the engine behind cross-file references (G-3, widened by N-1b/G-4: files
 * that merely USE the name belong to the answer, not only files that declare
 * it) and behind cross-file rename. Visible = open buffers from live text
 * (the live text always wins), plus indexed disk files RE-READ at request
 * time — the snapshot can be stale, and edits computed against stale text
 * rewrite the wrong ranges.
 *
 * `allowStale` splits what the two callers may assume: references tolerate a
 * file they cannot read right now (snapshot fallback) and a scan that skipped
 * files — an incomplete list is still an honest one; rename promises
 * completeness, so both come back as a refusal it must not work around.
 */
async function workspaceOccurrences(
  name: string,
  allowStale: boolean
): Promise<{ files: Map<string, Range[]>; refusal: ResponseError<void> | null }> {
  const files = new Map<string, Range[]>();
  // No root: the visible world is one file, and that file's features never
  // ask (every caller gates on a SHARED/routine name, which needs the index).
  if (!workspaceIndex.rootPath()) return { files, refusal: null };
  await workspaceIndex.whenSettled();
  const { skipped } = workspaceIndex.stats();
  if (skipped > 0 && !allowStale) return { files, refusal: renameBoundRefusal(name, skipped) };
  const add = (uri: string, text: string): void => {
    const ranges = occurrences(text, name);
    if (ranges.length) files.set(uri, ranges);
  };
  for (const doc of textDocuments.all()) add(doc.uri, doc.getText());
  const openUris = new Set(textDocuments.keys());
  for (const facts of workspaceIndex.factsFromDisk(openUris)) {
    let text: string;
    try {
      text = fs.readFileSync(fileURLToPath(facts.uri), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // deleted since the scan: nothing left to rename
      if (allowStale) {
        add(facts.uri, facts.text); // references tolerate one stale-read failure
        continue;
      }
      return {
        files: new Map(),
        refusal: new ResponseError(
          ErrorCodes.InvalidParams,
          `esql-lsp: cannot rename '${name}' across the workspace — ${facts.uri} could not ` +
            'be read at rename time, so a use of the name may live there unseen; a rename ' +
            'that skips it would leave that file broken'
        ),
      };
    }
    add(facts.uri, text);
  }
  return { files, refusal: null };
}

/** The rename refusal for a workspace the bounded index could not fully read. */
function renameBoundRefusal(name: string, skipped: number): ResponseError<void> {
  return new ResponseError(
    ErrorCodes.InvalidParams,
    `esql-lsp: cannot rename '${name}' across the workspace — the bounded index scan ` +
      `skipped ${skipped} file(s) (beyond its 500-file / 256 KB limits), so a use of this ` +
      'name may live in a file rename cannot see. Rename inside those files yourself, or ' +
      'point the workspace at a smaller folder.'
  );
}

/**
 * Cross-file references (CODE_REVIEW.md G-3, third files by N-1b/G-4). Two halves:
 *  - in-file: a SHARED name declared in a SIBLING has no local declaration,
 *    so `referencesAt` answered zero — the current file's own occurrences are
 *    then reported through the same whole-word finder the in-file path uses.
 *  - cross-file: EVERY visible file is scanned (live buffers first, disk
 *    files re-read fresh), not just the files whose located facts declare the
 *    name — a third file that only USES the name belongs to the answer too
 *    (workspace ≈ application is the documented approximation, review N-2).
 * A ROUTINE name that resolves inside the current file while a SIBLING also
 * declares it keeps its answer file-local (`Main` in ten files means ten
 * different routines, and sweeping one would drown the other nine); a SHARED
 * name is application-wide by definition and always gets the full sweep, as
 * does a name only THIS file declares SHARED (or as its sole routine) — the
 * G-4 half: the uses out in the application exist whether or not any sibling
 * re-declares the name.
 */
async function crossFileReferences(
  word: string,
  fromUri: string,
  localRanges: Range[],
  includeDeclaration: boolean,
  hereSharedOrRoutine: boolean
): Promise<Location[]> {
  const vars = lookupSharedVar(word).filter((v) => v.uri !== fromUri);
  const routines = lookupRoutine(word).filter((r) => r.uri !== fromUri);
  if (vars.length === 0 && routines.length === 0 && !hereSharedOrRoutine) return [];
  // A ROUTINE answered by the file itself (while a sibling ALSO declares it)
  // stays file-local (local shadow, same rule as definition); a SHARED name
  // always sweeps the workspace.
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

  // Every visible file — including `fromUri`, whose live text is scanned by
  // the engine exactly as the old code scanned it here (the engine answers
  // from live text for open buffers, fresh disk reads for the rest).
  const scan = await workspaceOccurrences(word, true);
  for (const [uri, ranges] of scan.files) add(uri, ranges);
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

/**
 * Quick fixes (E-9): the client echoes the findings it has in
 * `context.diagnostics`; the fixes themselves are recomputed from the
 * CURRENT text (an echo can be stale; an edit anchored in old text rewrites
 * the wrong characters), with the same workspace facts the publishing run
 * used — so a `Did you mean` action always offers what the message names,
 * in both modes. Fixes obey their check's toggle even for an echoed
 * diagnostic whose check is off now. See src/codeActions.ts.
 */
connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const doc = documentFor(params);
  if (!doc) return [];
  const text = doc.getText();
  const { analysis } = parsedDocument(doc.uri, text);
  try {
    return buildCodeActions(
      doc.uri,
      text,
      params.context?.diagnostics ?? [],
      settings.diagnostics,
      {
        analysis: analysis ?? undefined,
        workspaceSharedNames: sharedNamesFromWorkspace(),
        workspaceRoutineNames: routineNamesFromWorkspace(),
      }
    );
  } catch (err) {
    // A broken fix must never take the request down — no actions beats an
    // error popup on every keystroke the client re-asks about.
    connection.console.error(`esql-lsp: code action failed: ${String(err)}`);
    return [];
  }
});

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
  clientSupportsDocumentChanges =
    params.capabilities?.workspace?.workspaceEdit?.documentChanges === true;
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
      // Quick fixes over the published diagnostics (E-9, task 17). Quickfix
      // kind only: every action maps one published finding to its edit — no
      // refactor-family source operations are implemented, and advertising
      // kinds we never answer would light up client UI that stays empty.
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      // Same-file rename (N-1a, task 15). `prepareProvider` lets the client
      // grey out the UI before typing a new name; the refusal rules (SHARED
      // names, routines) answer through it, so they fire at F2, not after
      // Enter. Cross-file rename arrives with the workspace pass (task 16).
      renameProvider: { prepareProvider: true },
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
  const pd = parsedDocument(doc.uri, text);
  const analysis = pd.analysis;
  // C-6: what clause the TREE says the cursor sits in. Null without the
  // addon, outside any statement, or wherever damage before the cursor makes
  // the reading untrustworthy — every one of those keeps today's line-prefix
  // answer, which is the degradation promise, not an accident.
  const clausePrefix = pd.tree
    ? clausePrefixAt(pd.tree, scan(text).masked, doc.offsetAt(pos)) ?? undefined
    : undefined;
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
  }, clientWantsSnippets, completionFacts, clausePrefix);
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

connection.onReferences(async (params: ReferenceParams): Promise<Location[] | null> => {
  const doc = documentFor(params);
  if (!doc) return null;
  const position = viewPosition(doc, params.position);
  if (!position) return null;
  const text = doc.getText();
  const includeDeclaration = params.context?.includeDeclaration !== false;
  const analysis = parsedDocument(doc.uri, text).analysis ?? undefined;
  const ranges = referencesAt(
    text,
    position.line,
    position.character,
    includeDeclaration,
    analysis
  );
  const out = ranges.map((range) => Location.create(doc.uri, range));
  // G-3: merge the workspace half (no-op unless the name is SHARED or a
  // routine, see crossFileReferences). `hereSharedOrRoutine` asks the rename
  // resolver whether the word under the cursor is THIS file's SHARED variable
  // or routine — the G-4 case where the declaring file holds the only located
  // fact and sibling uses would otherwise go unlisted.
  const word = cursorWord(text, position.line, position.character);
  if (word) {
    const here = renameTargetAt(text, position, analysis);
    const hereSharedOrRoutine = !!here && (here.shared || here.kind === 'routine');
    const local = new Set(out.map((l) => `${l.range.start.line}:${l.range.start.character}`));
    for (const loc of await crossFileReferences(
      word,
      doc.uri,
      ranges,
      includeDeclaration,
      hereSharedOrRoutine
    )) {
      const key = `${loc.range.start.line}:${loc.range.start.character}`;
      if (loc.uri !== doc.uri || !local.has(key)) out.push(loc);
    }
  }
  return out.length ? out : null;
});

// ── rename (N-1a: prepareRename + same-file rename, CODE_REVIEW.md N-1) ────

/**
 * ESQL's 12 official RESERVED words — "you cannot use these keywords for
 * variable names" (12.0.x "ESQL reserved keywords", fetched verbatim
 * 2026-10-26). Only these are refused as rename targets: the NON-reserved
 * page only warns they "can become difficult to understand", and several
 * (NAME, VALUE, TYPE, DATA, LIST…) are common identifier shapes this
 * server's own completion offers — refusing them would refuse real code.
 * `ESQL_KEYWORDS` entries that are phrases ('GROUP BY', 'IS NOT NULL')
 * can never equal a single word, so this list is the whole rule.
 */
const ESQL_RESERVED_WORDS = new Set([
  'ALL', 'ASYMMETRIC', 'BOTH', 'CASE', 'DISTINCT', 'FROM', 'ITEM',
  'LEADING', 'NOT', 'SYMMETRIC', 'TRAILING', 'WHEN',
]);

/** What a rename targets: a DECLAREd name (variable or parameter) or a routine. */
interface RenameTarget {
  kind: 'variable' | 'routine';
  /** Name as written; placeholder material. */
  name: string;
  /** The word range under the cursor (what `prepareRename` highlights). */
  range: Range;
  shared: boolean;
}

/**
 * The variable-or-routine whose DECLARATION the cursor sits on, or null for
 * "not a renameable symbol here" — built-ins, path elements, comments,
 * modules, schemas, namespace aliases and anything undeclared answer null,
 * exactly the shape `referencesAt` reports as "no answer".
 *
 * Declared/routine names are matched over BOTH extraction sources
 * (tree-sitter when loaded, the pattern path otherwise), because rename
 * must offer what find-references offers. Namespace aliases are excluded
 * on purpose: the value of `DECLARE tns NAMESPACE 'uri'` IS the uri, and
 * renaming the prefix without offering the uri is half a rename (task 16's
 * workspace pass can do the whole thing). Module and schema names name
 * deployment artifacts (the filename, the deployed schema) — text-local
 * rename would break the match with reality.
 */
function renameTargetAt(
  text: string,
  position: Position,
  doc: DocAnalysis | undefined
): RenameTarget | null {
  const { lines, rawLines } = scan(text);
  const at = wordAtPosition(lines, rawLines, position.line, position.character);
  if (!at) return null;
  const eq = (n: string) => n.toUpperCase() === at.word.toUpperCase();
  const routines = doc ? doc.routines : routinesFromSource(text);
  if (routines.some((r) => eq(r.name)))
    return { kind: 'routine', name: at.word, range: at.range, shared: false };
  const declarations = doc ? doc.declaredNames : declarationsFromSource(text);
  // Both DeclKinds are renameable (PLAN N-1a: body/module variables AND
  // parameters; ESQL calls are positional, so a parameter rename can never
  // break a caller). `detail === 'NAMESPACE'` is how the PATTERN path
  // indexes the alias form (`DECLARE tns NAMESPACE 'uri'`); the tree keeps
  // those out of `declaredNames` (doc.namespaceAliases). Refuse them in
  // both modes: renaming the prefix without offering the uri it stands for
  // is half a rename, and the workspace pass is where the whole thing
  // belongs. A parameter never carries SHARED, so the refusal rules below
  // treat both kinds as the file-local 'variable' case.
  const decl = declarations.find((d) => eq(d.name) && d.detail !== 'NAMESPACE');
  if (decl) return { kind: 'variable', name: at.word, range: at.range, shared: decl.shared === true };
  return null;
}

/**
 * Is the declaration at `range` written in quotes (`DECLARE "a name" INTEGER`)?
 * The recorded range holds the BARE name with the quotes just outside it —
 * in both extraction paths — so adjacency answers this. A quoted
 * declaration is the one place a new name may be an odd shape: the grammar
 * accepts "enclosing names that do not conform to these rules in double
 * quotation marks", so the validator lets anything without a quote through
 * for those (and the edits rewrite inside the quotes, never touching them).
 */
function declarationIsQuoted(text: string, range: Range): boolean {
  const lines = linesOf(text);
  const before = (lines[range.start.line] ?? '').slice(range.start.character - 1, range.start.character);
  const after = (lines[range.end.line] ?? '').slice(range.end.character, range.end.character + 1);
  return before === '"' && after === '"';
}

/**
 * Validate the new name. Plain identifiers only — unless the declaration
 * being renamed is itself quoted, which licenses odd shapes. Reserved words
 * and collisions with the file's own names (ESQL matches case-insensitively,
 * so the check does too, and `x` → `X` would merge two declarations) are
 * refused: a rename that silently duplicates a DECLARE is worse than no
 * rename.
 */
function invalidNewName(name: string, quotedDeclaration: boolean): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'the new name is empty';
  if (name !== trimmed) return 'the new name has surrounding whitespace';
  if (!quotedDeclaration && !/^[_A-Za-z][_A-Za-z0-9]*$/.test(trimmed)) {
    return `'${trimmed}' is not an ESQL identifier (letters, digits, underscore, not starting with a digit)`;
  }
  if (quotedDeclaration && trimmed.includes('"')) {
    return 'a quoted name cannot contain a double quote (escape it as two double quotes)';
  }
  if (/^[_A-Za-z][_A-Za-z0-9]*$/.test(trimmed) && ESQL_RESERVED_WORDS.has(trimmed.toUpperCase())) {
    return `'${trimmed}' is an ESQL reserved keyword — you cannot use it for a variable name`;
  }
  return null;
}

/** What `prepareRename` may answer: a range, a range + placeholder, a
 * refusal the client shows, or null for "grey the action out". */
type PrepareRenameAnswer =
  | Range
  | { range: Range; placeholder: string }
  | ResponseError<void>
  | null;

connection.onPrepareRename(
  async (params: PrepareRenameParams): Promise<PrepareRenameAnswer> => {
    const doc = documentFor(params);
    if (!doc) return null;
    const position = viewPosition(doc, params.position);
    if (!position) return null;
    const text = doc.getText();
    const target = renameTargetAt(text, position, parsedDocument(doc.uri, text).analysis ?? undefined);
    if (!target) return null; // the cursor is not on a declared name — greyed out, no error dialog
    const refusal = await renameRefusal(target);
    if (refusal) return refusal;
    // Placeholder = the BARE name (quoted declarations record their name
    // unquoted in both paths), so the client's input box prefills a name the
    // validator will accept again.
    return { range: target.range, placeholder: target.name }
  });

connection.onRenameRequest(
  async (params: RenameParams): Promise<WorkspaceEdit | null | ResponseError<void>> => {
    const doc = documentFor(params);
    if (!doc) return null;
    const position = viewPosition(doc, params.position);
    if (!position) return null;
    const text = doc.getText();
    const analysis = parsedDocument(doc.uri, text).analysis ?? undefined;
    const target = renameTargetAt(text, position, analysis);
    if (!target) {
      return new ResponseError(
        ErrorCodes.InvalidParams,
        'esql-lsp: nothing to rename here — the cursor is not on a declared variable, ' +
          'parameter or routine name'
      );
    }
    const refusal = await renameRefusal(target);
    if (refusal) return refusal;

    // New-name validation, against the SAME name universe the rename edits:
    // declarations, routines, modules, schemas and namespace aliases of this
    // file (ESQL is case-insensitive, so is the collision check).
    const declarations = analysis ? analysis.declaredNames : declarationsFromSource(text);
    const decl = declarations.find((d) => d.name.toUpperCase() === target.name.toUpperCase());
    const quoted = decl ? declarationIsQuoted(text, decl.range) : false;
    const bad = invalidNewName(params.newName, quoted);
    if (bad) return new ResponseError(ErrorCodes.InvalidParams, `esql-lsp: cannot rename to '${params.newName}' — ${bad}`);
    const takenHere = new Set<string>();
    for (const d of declarations) takenHere.add(d.name.toUpperCase());
    if (analysis) {
      for (const r of analysis.routines) takenHere.add(r.name.toUpperCase());
      for (const m of analysis.modules) takenHere.add(m.name.toUpperCase());
      for (const s of analysis.schemas) takenHere.add(s.name.toUpperCase());
      for (const a of analysis.namespaceAliases) takenHere.add(a.name.toUpperCase());
    } else {
      for (const r of routinesFromSource(text)) takenHere.add(r.name.toUpperCase());
      for (const m of modulesFromSource(text)) takenHere.add(m.name.toUpperCase());
      const schema = schemaFromSource(text);
      if (schema) takenHere.add(schema.name.toUpperCase());
    }
    const upper = params.newName.toUpperCase();
    // The target's own name is not a collision: `total` → `Total` is a case
    // fix, and the edits below rewrite every occurrence to the new spelling.
    // Anything else the file already answers to is — a rename that leaves two
    // declarations ESQL reads as one name is worse than no rename.
    if (upper !== target.name.toUpperCase() && takenHere.has(upper)) {
      return new ResponseError(
        ErrorCodes.InvalidParams,
        `esql-lsp: cannot rename to '${params.newName}' — the file already has a name that reads the same (ESQL names are case-insensitive)`
      );
    }

    // Names that reach past this file (SHARED variable, routine) are renamed
    // across the whole workspace — `sweeping` is what `renameRefusal` already
    // decided (a root exists; without one this file is the entire visible
    // world, so the file-local edit is complete — task 15's rule, kept).
    const sweeping =
      workspaceIndex.rootPath() !== undefined && (target.shared || target.kind === 'routine');
    if (sweeping && upper !== target.name.toUpperCase()) {
      // The workspace half of the collision rule: SHARED `Counter` renamed to a
      // name a SIBLING declares SHARED (or a routine name a sibling declares)
      // creates the application-level clash ESQL can only resolve by shadowing
      // or error. Same-kind only: variables and routines live in different
      // resolution contexts, exactly like `CALL` vs `SET` in E-4.
      const rivals =
        target.kind === 'routine' ? lookupRoutine(params.newName) : lookupSharedVar(params.newName);
      const rival = rivals.find((c) => c.uri !== doc.uri);
      if (rival) {
        return new ResponseError(
          ErrorCodes.InvalidParams,
          `esql-lsp: cannot rename to '${params.newName}' — ${rival.uri} already declares a ` +
            `${target.kind === 'routine' ? 'routine' : 'SHARED variable'} with that name ` +
            '(ESQL names are case-insensitive)'
        );
      }
    }

    // referencesAt(includeDeclaration = true) is the range engine: same
    // quoted-aware occurrence matching find-references uses, so what the
    // user saw under "find references" is exactly what changes.
    const ranges = referencesAt(text, position.line, position.character, true, analysis);
    const changes = new Map<string, { range: Range; newText: string }[]>();
    const seen = new Set<string>();
    for (const r of ranges) {
      const key = `${r.start.line}:${r.start.character}|${r.end.line}:${r.end.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = changes.get(doc.uri) ?? [];
      list.push({ range: r, newText: params.newName });
      changes.set(doc.uri, list);
    }
    if (!seen.size) return null;

    // N-1b + G-4: a name the workspace can see in OTHER files gets those
    // rewritten too, with the same whole-word finder find-references used — so
    // the cross-file edit list is the cross-file reference list, both modes
    // (the scan is pattern-based by construction). This file keeps
    // referencesAt's scope-aware ranges from above.
    const crossFiles: string[] = [];
    if (sweeping) {
      const scan = await workspaceOccurrences(target.name, false);
      if (scan.refusal) return scan.refusal;
      for (const [uri, at] of scan.files) {
        if (uri === doc.uri) continue; // this file's ranges are the referencesAt ones
        changes.set(uri, at.map((r) => ({ range: r, newText: params.newName })));
        crossFiles.push(uri);
      }
    }
    if (!crossFiles.length) return { changes: Object.fromEntries(changes) };

    // SHARED-scope honesty (task 16): ACE keeps SHARED variables visible
    // application-wide and routines callable from anywhere in the application;
    // the workspace is the DOCUMENTED approximation of "the application", and
    // the approximation gets surfaced where the user can act on it — a
    // window/showMessage every client shows, plus a 3.16 change annotation for
    // clients that render one in their edit preview.
    const scopeNote = target.shared
      ? `esql-lsp: renamed '${target.name}' in ${crossFiles.length + 1} workspace files. ACE ` +
        `keeps SHARED variables visible application-wide — files outside this workspace ` +
        `may still use '${target.name}'.`
      : `esql-lsp: renamed '${target.name}' in ${crossFiles.length + 1} workspace files. The ` +
        `application may have files outside this workspace that still call '${target.name}'.`;
    connection.window.showInformationMessage(scopeNote);
    if (!clientSupportsDocumentChanges) return { changes: Object.fromEntries(changes) };
    return {
      documentChanges: [doc.uri, ...crossFiles].map((uri) => ({
        textDocument: { uri, version: textDocuments.get(uri)?.version ?? null },
        edits: (changes.get(uri) ?? []).map((e) => ({ range: e.range, newText: e.newText })),
        annotationIds: [APPLICATION_SCOPE_ANNOTATION],
      })),
      changeAnnotations: {
        [APPLICATION_SCOPE_ANNOTATION]: { label: scopeNote, needsConfirmation: false },
      },
      // LSP 3.16 fields: the pinned protocol typings predate changeAnnotations.
    } as unknown as WorkspaceEdit
  });

/**
 * Which rename refusals answer at `prepareRename` too, so a well-behaved
 * client blocks at F2 instead of after the user typed (N-1a). What is NOT
 * here anymore (N-1b): SHARED variables and routines with a workspace root —
 * those are now RENAMED workspace-wide (task 16), and the refusal only
 * guards the renames the workspace cannot do completely. Excluded by absence
 * from `renameTargetAt` instead: modules, schemas, namespace aliases,
 * undeclared names, built-ins, path elements.
 */
async function renameRefusal(target: RenameTarget): Promise<ResponseError<void> | null> {
  // `Main()` is not a user-chosen name: the ACE runtime calls exactly that
  // routine in every compute module (12.0.x: a module "must contain a
  // Main() function"). Renaming it is never what the user wants, in any
  // mode, rooted or not — and `module-no-main` would then warn.
  if (target.kind === 'routine' && target.name.toUpperCase() === 'MAIN') {
    return new ResponseError(
      ErrorCodes.InvalidParams,
      "esql-lsp: cannot rename 'Main' — ACE calls that routine by name in every " +
        'compute module; renaming it makes the module unexecutable'
    );
  }
  // Without a root this file is the whole visible world: even a SHARED
  // rename is complete here (task 15's rule, kept). A file-scope variable
  // never reaches a second file in either world.
  if (!workspaceIndex.rootPath()) return null;
  if (target.kind === 'variable' && !target.shared) return null;
  // SHARED / routine with a root: the edit goes workspace-wide, so the
  // scan's bounds are the rename's bounds. A scan that SKIPPED files could
  // hide a use — half a rename, which is exactly what the refusal exists for.
  await workspaceIndex.whenSettled();
  const { skipped } = workspaceIndex.stats();
  if (skipped > 0) return renameBoundRefusal(target.name, skipped);
  return null;
}

/** The `changeAnnotations` id of the cross-file scope note (LSP 3.16). */
const APPLICATION_SCOPE_ANNOTATION = 'esql-application-scope';

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
