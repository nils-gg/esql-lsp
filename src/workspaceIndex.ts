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
 *   - file watching (list.md 7) is CLIENT cooperation: the server registers a
 *     recursive watcher for `.esql` files when the client declares
 *     `dynamicRegistration`, and applies `workspace/didChangeWatchedFiles`
 *     events incrementally. A client
 *     that never sends events gets exactly the old behaviour — the initial
 *     scan plus live buffers — which is the promised degradation, not a new
 *     failure mode.
 *   - several workspace folders are all indexed (list.md 8); an editor
 *     workspace is still treated as ONE flat namespace, the documented
 *     stand-in for ACE's application boundary.
 *   - hard bounds below; a workspace with more files gets a partial index,
 *     and the counts are logged rather than silently truncated. A watcher
 *     event for an over-bound file raises `skipped` too, so the rename
 *     refusal gate widens instead of pretending the file is unseen.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
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
  /**
   * The snapshot text, kept so the cross-file reference scan (G-3) can find
   * occurrences in files nobody has open. Memory is bounded by the same
   * MAX_FILES × MAX_FILE_BYTES that produced it (worst case 128 MB, in
   * practice ~15 KB × the file count).
   */
  text: string;
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
const MAX_ROOTS = 16; // workspace folders indexed at once
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
  return { uri, text, sharedVars, sharedNames, symbols };
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

/** Push into a name-keyed view, opening the bucket when needed (scan + incremental share this). */
function addToNameKeyed<T>(map: Map<string, T[]>, name: string, item: T): void {
  const key = name.toUpperCase();
  const bucket = map.get(key) ?? [];
  bucket.push(item);
  if (!map.has(key)) map.set(key, bucket);
}

/** Drop matching entries from a name-keyed view, empty buckets deleted so lookups stay O(1)-clean. */
function removeFromNameKeyed<T>(map: Map<string, T[]>, name: string, drop: (item: T) => boolean): void {
  const key = name.toUpperCase();
  const bucket = map.get(key);
  if (!bucket) return;
  const kept = bucket.filter((item) => !drop(item));
  if (kept.length === 0) map.delete(key);
  else map.set(key, kept);
}

/**
 * Path equality that ignores case only where the filesystem does (Windows).
 * Roots and watch-event URIs reach us from different client code paths, and
 * drive-letter/case drift must not make a real event look foreign.
 */
function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

export class WorkspaceIndex {
  /**
   * Every workspace folder the client reported (list.md 8), absolute paths,
   * in client order, deduplicated. Overlapping folders are tolerated: the
   * scan keys files by absolute path, so a file inside two roots indexes once.
   */
  private roots: string[] = [];
  /** bumped whenever `roots` actually changes — see the generation guard on scans */
  private rootsGeneration = 0;
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
  private scanning: { gen: number; promise: Promise<void> } | undefined;

  /** Replace the root list (single-root callers just pass one entry). */
  setRoots(roots: string[]): void {
    const next: string[] = [];
    for (const r of roots) {
      if (r && !next.includes(r)) next.push(r);
    }
    if (next.length !== this.roots.length || next.some((r, i) => r !== this.roots[i])) {
      this.roots = next;
      this.rootsGeneration++;
    }
  }

  /** @deprecated single-root alias for `setRoots`; kept for existing callers. */
  setRoot(rootPath: string | undefined): void {
    this.setRoots(rootPath ? [rootPath] : []);
  }

  /** Add one folder; false when already present or at the MAX_ROOTS cap. */
  addRoot(rootPath: string): boolean {
    if (this.roots.includes(rootPath)) return false;
    if (this.roots.length >= MAX_ROOTS) return false;
    this.roots.push(rootPath);
    this.rootsGeneration++;
    return true;
  }

  /** Remove one folder; false when it was not indexed. Path comparison is case-folded on Windows. */
  removeRoot(rootPath: string): boolean {
    const idx = this.roots.findIndex((r) => samePath(r, rootPath));
    if (idx === -1) return false;
    this.roots.splice(idx, 1);
    this.rootsGeneration++;
    return true;
  }

  rootPaths(): readonly string[] {
    return this.roots;
  }

  hasRoot(): boolean {
    return this.roots.length > 0;
  }

  /** The first root, or undefined — "is there a workspace" for boolean callers. */
  rootPath(): string | undefined {
    return this.roots[0];
  }

  /**
   * Kick off (or repeat) the bounded scan. Never rejects; a root that cannot
   * be read leaves the index empty — features behave exactly as before the
   * index existed, which is the degradation path this project promises.
   * Empty roots RESET the index: removing the last workspace folder must not
   * leave its symbols behind.
   */
  rescan(): Promise<void> {
    if (this.roots.length === 0) {
      if (!this.scanning) this.resetEmpty();
      return Promise.resolve();
    }
    if (!this.scanning || this.scanning.gen !== this.rootsGeneration) {
      // Either no scan is in flight, or the roots changed while one was —
      // that walk no longer matches the workspace, so start a fresh one and
      // let the generation guard discard the stale result.
      const gen = this.rootsGeneration;
      const promise = this.scanNow(gen).finally(() => {
        if (this.scanning?.gen === gen) this.scanning = undefined;
      });
      this.scanning = { gen, promise };
    }
    return this.scanning.promise;
  }

  /** Scan-completion promise for callers that must wait before trusting results. */
  whenSettled(): Promise<void> {
    return this.scanning?.promise ?? Promise.resolve();
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

  /**
   * Whole FileFacts of the snapshot (text included), for the cross-file
   * occurrence scan (G-3). Same exclusion contract as every other reader:
   * the caller replaces open buffers with their live text itself.
   */
  factsFromDisk(excludingUris?: Iterable<string>): FileFacts[] {
    const skip = excludingUris ? new Set(excludingUris) : undefined;
    const out: FileFacts[] = [];
    for (const facts of this.files.values()) {
      if (skip?.has(facts.uri)) continue;
      out.push(facts);
    }
    return out;
  }

  /**
   * Apply one `workspace/didChangeWatchedFiles` event (list.md 7). LSP
   * `FileChangeType`: Created = 1, Changed = 2, Deleted = 3. Returns whether
   * the event touched the index — the server revalidates only then.
   *
   * The file is RE-READ from disk here; the point of the watcher is that the
   * closed file's current bytes matter, so this never trusts the snapshot.
   * An over-cap or unreadable file raises `skippedCount` instead of silently
   * vanishing: consumers whose honesty depends on `skipped` (the rename
   * refusal gate) then widen their refusal rather than over-trusting the
   * index. `skippedCount` only resets on a full rescan, which is the
   * conservative direction.
   */
  async applyWatchEvent(uri: string, type: number): Promise<boolean> {
    if (!this.hasRoot() || !/\.esql$/i.test(uri)) return false;
    let full: string;
    try {
      full = fileURLToPath(uri);
    } catch {
      return false; // a malformed URI is indistinguishable from "not ours"
    }
    if (!this.underRoots(full)) return false; // the client may watch more than we asked
    // Never mutate while a walk is building a replacement map — it would be
    // clobbered when the walk lands. The walk reads the same disk this event
    // points at, so waiting costs the event's freshness nothing.
    if (this.scanning) await this.scanning.promise;
    const key = this.entryKey(full);
    if (type === 3 /* Deleted */) {
      if (key === undefined) return false;
      this.removeEntry(key);
      return true;
    }
    let text: string;
    try {
      const stat = await fs.promises.stat(full);
      if (stat.size > MAX_FILE_BYTES) {
        if (key !== undefined) this.removeEntry(key);
        this.skippedCount++;
        return true;
      }
      text = await fs.promises.readFile(full, 'utf8');
    } catch {
      // Gone or unreadable between event and read: treat as the removal the
      // client would send next, and be conservative about the bounds — the
      // scan's own read-failure path counts a skip for exactly this file too.
      if (key !== undefined) this.removeEntry(key);
      this.skippedCount++;
      return true;
    }
    if (key !== undefined) this.removeEntry(key); // path spelling may differ
    try {
      this.addEntry(full, extractFileFacts(text, pathToFileURL(full).href));
    } catch {
      // A file must never take the index down with it — same rule as the scan.
      this.skippedCount++;
      return true;
    }
    return true;
  }

  private underRoots(full: string): boolean {
    const f = path.resolve(full);
    return this.roots.some((r) => {
      const rel = path.relative(path.resolve(r), f);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  }

  /** The map key holding this path — exact first, then a Windows case match. */
  private entryKey(full: string): string | undefined {
    if (this.files.has(full)) return full;
    if (process.platform !== 'win32') return undefined;
    for (const k of this.files.keys()) if (samePath(k, full)) return k;
    return undefined;
  }

  private removeEntry(key: string): void {
    const facts = this.files.get(key);
    this.files.delete(key);
    if (!facts) return;
    for (const s of facts.symbols) {
      if (s.kind === 'routine')
        removeFromNameKeyed(this.routinesByName, s.name, (e) => e.uri === facts.uri);
    }
    for (const v of facts.sharedVars)
      removeFromNameKeyed(this.sharedVarsByName, v.name, (e) => e.uri === facts.uri);
  }

  private addEntry(full: string, facts: FileFacts): void {
    this.files.set(full, facts);
    for (const s of facts.symbols) {
      if (s.kind !== 'routine') continue;
      addToNameKeyed(this.routinesByName, s.name, s);
    }
    for (const v of facts.sharedVars) addToNameKeyed(this.sharedVarsByName, v.name, v);
  }

  private resetEmpty(): void {
    this.files = new Map();
    this.routinesByName = new Map();
    this.sharedVarsByName = new Map();
    this.scannedCount = 0;
    this.skippedCount = 0;
  }

  private async scanNow(gen: number): Promise<void> {
    const roots = [...this.roots];
    if (roots.length === 0) return;
    const found = new Map<string, FileFacts>();
    let scanned = 0;
    let skipped = 0;
    for (const root of roots) {
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
          if (found.has(full)) continue; // overlapping roots: the file is already indexed
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
    }
    if (gen !== this.rootsGeneration) {
      // The workspace folders changed while this walk ran — its file set was
      // assembled against roots that no longer describe the workspace. Drop
      // it; whoever changed the roots has already queued a matching rescan.
      return;
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
