/**
 * A lightweight workspace index (ISSUES.md I-13).
 *
 * Why: every `.esql` file of an ACE application talks to the others through
 * `DECLARE … SHARED` variables and `CALL` into sibling routines, and without
 * a workspace view the undeclared-variable check called those names bugs —
 * `FailureCount` is declared in `Receiver.esql` and the flag fired in
 * `ReceiverExceptionHandler.esql`. Suppressing the check instead would hide
 * the real bug class; the honest fix is to know what the workspace declares.
 *
 * The index is deliberately boring: a bounded, one-pass, file-system scan of
 * `*.esql` under the client's workspace root, run once per session (async,
 * after `initialized`), plus the live text of every open document, which
 * always wins over the on-disk copy. It reads each file with the SAME
 * pattern extractors as the heuristic fallback (`declarationsFromSource` et
 * al.), so it works identically with and without the grammar addon — the
 * grammar only makes the current document's own analysis better.
 *
 * Known approximations, on purpose:
 *   - "workspace-wide" stands in for ACE's application-wide SHARED scope;
 *     an LSP has no application boundary to consult.
 *   - no file watching: files created/edited outside the editor after the
 *     initial scan are invisible until the server restarts (open documents
 *     are live, everything else is the scan snapshot).
 *   - hard bounds below; a workspace with more files gets a partial index,
 *     and the counts are logged rather than silently truncated.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { Range } from 'vscode-languageserver-types';
import {
  declarationsFromSource,
  modulesFromSource,
  routinesFromSource,
  schemaFromSource,
} from './definitions';

/**
 * A `DECLARE … SHARED` variable with a home (CODE_REVIEW.md N-2). The I-13
 * undeclared-check only ever needed the NAME; cross-file definition, hover,
 * completion detail and rename all need where and what type, so the located
 * fact is the primary record and `FileFacts.sharedNames` is derived from it.
 */
export interface SharedVarFact {
  /** Declared spelling (ESQL names are case-insensitive; keep the original). */
  name: string;
  uri: string;
  /** Range of the declared name itself — a definition/rename target. */
  range: Range;
  /** Human-readable type for hover/completion, e.g. 'INTEGER' or 'CONSTANT CHARACTER'. */
  detail: string;
}

/** One indexed `.esql` file, reduced to what siblings can rely on. */
export interface FileFacts {
  uri: string;
  /** Located `DECLARE … SHARED` variables, declaration order (N-2). */
  sharedVars: SharedVarFact[];
  /** UPPERCASE names of those variables (I-13's core need), derived. */
  sharedNames: Set<string>;
  /** Symbols this file contributes to `workspace/symbol`. */
  symbols: WorkspaceSymbol[];
}

/** Flat `workspace/symbol` material, resolved lazily by the server. */
export interface WorkspaceSymbol {
  name: string;
  /** LSP SymbolKind numbers, filled by the server (index stays protocol-light). */
  kind: 'module' | 'routine' | 'schema';
  detail: string;
  /** Containing module name for routines (SymbolInformation's containerName). */
  container: string;
  uri: string;
  range: Range;
}

const MAX_FILES = 500; // indexed .esql files
const MAX_FILE_BYTES = 256 * 1024; // larger files are skipped (real ones are < 15 KB)
const MAX_DEPTH = 12;
const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  'bin',
  'obj',
  '.idea',
  '.vscode',
  'vendor',
]);

/**
 * Reduce one file's text to FileFacts. Exported because the server runs it
 * over live open-document text too — the same code path decides what disk
 * and buffer contribute to the workspace view.
 */
export function extractFileFacts(text: string, uri: string): FileFacts {
  const sharedVars: SharedVarFact[] = [];
  for (const d of declarationsFromSource(text)) {
    if (d.shared && d.kind === 'variable')
      sharedVars.push({ name: d.name, uri, range: d.range, detail: d.detail });
  }
  const sharedNames = new Set<string>(sharedVars.map((v) => v.name.toUpperCase()));
  const symbols: WorkspaceSymbol[] = [];
  const mods = modulesFromSource(text);
  for (const m of mods) {
    symbols.push({ name: m.name, kind: 'module', detail: `${m.kind} MODULE`, container: '', uri, range: m.nameRange });
  }
  // One module per file is the overwhelmingly common shape; when a file has
  // several, the first is honest enough for a flat workspace outline.
  const container = mods[0]?.name ?? '';
  for (const r of routinesFromSource(text)) {
    symbols.push({
      name: r.name,
      kind: 'routine',
      container,
      detail: r.kind === 'PROCEDURE' ? 'PROCEDURE' : `FUNCTION${r.returnType ? ` RETURNS ${r.returnType}` : ''}`,
      uri,
      range: r.range,
    });
  }
  const schema = schemaFromSource(text);
  if (schema)
    symbols.push({ name: schema.name, kind: 'schema', detail: 'BROKER SCHEMA', container: '', uri, range: schema.range });
  return { uri, sharedVars, sharedNames, symbols };
}

/** Keep the entries whose URI the caller replaces with live text out of a result. */
function filterSkip<T>(
  list: T[] | undefined,
  excludingUris: Iterable<string> | undefined,
  uriOf: (item: T) => string
): T[] {
  if (!list || list.length === 0) return [];
  if (!excludingUris) return [...list];
  const skip = new Set(excludingUris);
  return list.filter((item) => !skip.has(uriOf(item)));
}

export class WorkspaceIndex {
  private root: string | undefined;
  /** absolute path -> facts (files that read but failed map to empty facts is WRONG; they are simply absent + counted). */
  private files = new Map<string, FileFacts>();
  /**
   * Name-keyed views over `files`, rebuilt with every scan (N-2): ESQL names
   * are case-insensitive, so the key is UPPERCASE. Lists because a name can
   * legitimately appear in several files (the caller decides who wins).
   */
  private routinesByName = new Map<string, WorkspaceSymbol[]>();
  private sharedVarsByName = new Map<string, SharedVarFact[]>();
  private scannedCount = 0;
  private skippedCount = 0;
  private scanning: Promise<void> | undefined;

  setRoot(rootPath: string | undefined): void {
    this.root = rootPath;
  }

  rootPath(): string | undefined {
    return this.root;
  }

  /**
   * Kick off (or repeat) the bounded scan. Never rejects; a root that cannot
   * be read leaves the index empty — features behave exactly as before the
   * index existed, which is the degradation path this project promises.
   */
  rescan(): Promise<void> {
    if (!this.root) return Promise.resolve();
    if (!this.scanning) {
      this.scanning = this.scanNow().finally(() => {
        this.scanning = undefined;
      });
    }
    return this.scanning;
  }

  /** Scan-completion promise for callers that must wait before trusting results. */
  whenSettled(): Promise<void> {
    return this.scanning ?? Promise.resolve();
  }

  stats(): { files: number; skipped: number } {
    return { files: this.files.size, skipped: this.skippedCount };
  }

  /**
   * SHARED names from the disk snapshot, minus any URIs the caller says are
   * live (their open text supersedes the snapshot — the server merges those
   * itself via extractFileFacts).
   */
  sharedNamesFromDisk(excludingUris?: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const skip = excludingUris ? new Set(excludingUris) : undefined;
    for (const facts of this.files.values()) {
      if (skip?.has(facts.uri)) continue;
      for (const name of facts.sharedNames) out.add(name);
    }
    return out;
  }

  /**
   * Every located SHARED fact on disk (N-2), same exclusion contract as
   * `sharedNamesFromDisk`. `server.ts` merges the live-document overlay on
   * top so every consumer sees one view.
   */
  sharedVarsFromDisk(excludingUris?: Iterable<string>): SharedVarFact[] {
    const out: SharedVarFact[] = [];
    const skip = excludingUris ? new Set(excludingUris) : undefined;
    for (const facts of this.files.values()) {
      if (skip?.has(facts.uri)) continue;
      out.push(...facts.sharedVars);
    }
    return out;
  }

  /**
   * Disk routines with this (case-insensitive) name — O(1) name match, the
   * per-entry URI filter is over that name's small list only.
   */
  routinesNamed(name: string, excludingUris?: Iterable<string>): WorkspaceSymbol[] {
    return filterSkip(this.routinesByName.get(name.toUpperCase()), excludingUris, (s) => s.uri);
  }

  /** Disk SHARED variables with this (case-insensitive) name. */
  sharedVarsNamed(name: string, excludingUris?: Iterable<string>): SharedVarFact[] {
    return filterSkip(this.sharedVarsByName.get(name.toUpperCase()), excludingUris, (v) => v.uri);
  }

  /** All disk-snapshot symbols, minus the URIs the caller replaces with live text. */
  symbolsFromDisk(excludingUris?: Iterable<string>): WorkspaceSymbol[] {
    const skip = excludingUris ? new Set(excludingUris) : undefined;
    const out: WorkspaceSymbol[] = [];
    for (const facts of this.files.values()) {
      if (skip?.has(facts.uri)) continue;
      out.push(...facts.symbols);
    }
    return out;
  }

  private async scanNow(): Promise<void> {
    const root = this.root;
    if (!root) return;
    const found = new Map<string, FileFacts>();
    let scanned = 0;
    let skipped = 0;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length > 0 && scanned < MAX_FILES) {
      const { dir, depth } = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable subdirectory: the scan is bounded and partial
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          if (depth + 1 <= MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile() || !/\.esql$/i.test(entry.name)) continue;
        if (scanned >= MAX_FILES) {
          skipped++;
          continue;
        }
        let text: string;
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > MAX_FILE_BYTES) {
            skipped++;
            continue;
          }
          text = await fs.promises.readFile(full, 'utf8');
        } catch {
          skipped++;
          continue;
        }
        scanned++;
        const uri = pathToFileURL(full).href;
        try {
          found.set(full, extractFileFacts(text, uri));
        } catch {
          // A file must never take the index down with it.
        }
      }
    }
    this.files = found;
    // Rebuild the name-keyed views atomically with the file map, so a lookup
    // can never see an index mid-scan.
    const routines = new Map<string, WorkspaceSymbol[]>();
    const shared = new Map<string, SharedVarFact[]>();
    for (const facts of found.values()) {
      for (const s of facts.symbols) {
        if (s.kind !== 'routine') continue;
        const key = s.name.toUpperCase();
        (routines.get(key) ?? routines.set(key, []).get(key)!).push(s);
      }
      for (const v of facts.sharedVars) {
        const key = v.name.toUpperCase();
        (shared.get(key) ?? shared.set(key, []).get(key)!).push(v);
      }
    }
    this.routinesByName = routines;
    this.sharedVarsByName = shared;
    this.scannedCount = scanned;
    this.skippedCount = skipped;
  }
}
