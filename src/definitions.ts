/**
 * Go-to-definition and find-references for ESQL symbols (Phase 2).
 *
 * With the grammar loaded, everything comes from the parse tree: `
 * analyzeDocument()` already extracted declarations with their visibility
 * scope (module / routine body / file), plus every variable and routine
 * reference. Without it (no C toolchain, addon build failure) the module
 * falls back to the Phase 1 patterns on the masked source — coarser
 * (declaration scope is file-wide, and only names on the same line as their
 * `DECLARE` / parameter list are found) but never absent.
 *
 * Symbols covered: variables and constants (DECLARE), routine parameters,
 * user-defined functions/procedures, and module names.
 */

import { Range } from 'vscode-languageserver';
import { scan, wordAt, findBeginToken, findEndToken, unquoteESQLName, QuotedToken } from './scanner';
import type { DocAnalysis, DeclaredName, RoutineInfo, SetTarget } from './parser';

/** `SET bareName =` / `:=`, rejecting dotted message-tree paths (see bareTargetsFromSource). */
const SET_TARGET_RE = /^\s*SET\s+([A-Za-z_]\w*)(?!\s*\.)\s*(?:=|:=)/i;

/**
 * Routine header. The parameter list and the RETURNS clause are BOTH optional
 * here because a real header may be split across lines
 *
 *     CREATE FUNCTION getPolicyProperty(
 *         IN policyName CHARACTER,
 *         IN propertyName CHARACTER)
 *     RETURNS CHARACTER
 *
 * `params` and `returnType` are therefore filled in from the lines the header
 * spans (see `routinesFromSource`), not from these groups alone.
 */
const FN_RE =
  /\bCREATE\s+(FUNCTION|PROCEDURE)\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?(\s+RETURNS\s+([A-Za-z]+))?/i;

// ─── Shared declaration patterns ─────────────────────────────────────────────
// These live here because this module is the single pattern extractor the
// analyzer, symbols, hover and completion all read from (see AGENTS.md): one
// place decides what counts as declared, so the four features cannot disagree.
// The scan() view is masked (comments/strings blanked, positions preserved).
// Pinned by CODE_REVIEW.md T-4/E-6: a consumer (diagnostics.ts included)
// IMPORTS these matchers — re-typing a near-copy elsewhere is how DATABASEEVENT
// silently fell out of the module checks and how the SHARED flag drifted
// between modes (C-7).

/** `DECLARE name[, name…] [CONSTANT|SHARED|EXTERNAL] type …` — group 1 is the
 * FULL comma-separated name list (a multi-name declaration declares every
 * name), group 2 the type word. Handler declarations (`DECLARE CONTINUE|EXIT
 * HANDLER …`) declare no variable and are excluded; so are routine headers
 * (`DECLARE PROCEDURE|FUNCTION …`), which `routinesFromSource` owns — without
 * that guard `DECLARE PROCEDURE Main()` declared a variable named PROCEDURE
 * of type Main, exactly like a mid-edit buffer that stopped at the word after
 * DECLARE (found via issue 3's cross-module fixture).
 *
 * The type word must not be another flag word: mid-edit `DECLARE x SHARED `
 * (buffer being typed, no datatype yet) then declares NOTHING, which is what
 * the tree path does too — a `declare_statement` without a `datatype` child
 * is the namespace-alias form and is not indexed (CODE_REVIEW.md C-7: without
 * the guard the heuristic indexed x typed `SHARED` and the modes drifted). */
const DECLARE_RE =
  /\bDECLARE\s+(?!CONTINUE\b|EXIT\b|PROCEDURE\b|FUNCTION\b)((?:[A-Za-z_]\w*\s*,\s*)*[A-Za-z_]\w*)\s+(?:CONSTANT\s+|SHARED\s+|EXTERNAL\s+)*(?!(?:SHARED|EXTERNAL|CONSTANT)\b)([A-Za-z]+)/i;

/**
 * `DECLARE "a name an identifier cannot hold" [SHARED|EXTERNAL|CONSTANT] type …`
 * — the form used for names bound to configured/script values. Matched against
 * the RAW line (the masked view blanks the name away), but only after the same
 * position is confirmed to be live code, so a comment cannot declare anything.
 * A doubled `""` inside the name is one escaped quote (the scanner's own
 * convention); the stored name is the unescaped one, same as the tree path
 * (G-5 parity).
 */
const QUOTED_DECLARE_RE =
  /^\s*DECLARE\s+"((?:[^"]|"")+)"\s+(?:(SHARED|EXTERNAL|CONSTANT)\s+)*(?:([A-Za-z]+))?/i;

/** One `[IN|OUT|INOUT] name [CONSTANT] TYPE` inside a parameter list. */
const PARAM_PART_RE =
  /^\s*(?:(?:IN|OUT|INOUT)\s+)?([A-Za-z_]\w*)\s*(?:(CONSTANT)\s+)?([A-Za-z]+)?/i;

/** `CREATE (COMPUTE|FILTER|DATABASE|DATABASEEVENT) MODULE name` (fallback path).
 * Exported because it is also THE module-boundary scanner for diagnostics.ts:
 * the earlier local copy in that file omitted DATABASEEVENT, so
 * `missing-end-module`/`module-no-main` stayed silent on DATABASEEVENT modules
 * (CODE_REVIEW.md E-6). Import this one — fallback regexes live in this file
 * and are imported, never re-typed somewhere else (T-4). */
export const MODULE_RE =
  /\bCREATE\s+(COMPUTE|FILTER|DATABASE|DATABASEEVENT)\s+MODULE\s+([A-Za-z_]\w*)/i;
/** `END MODULE` — same single-source rule as `MODULE_RE`. */
export const END_MODULE_RE = /\bEND\s+MODULE\b/i;

/** `BROKER SCHEMA a.b.c` — the application's schema declaration. */
const BROKER_RE = /\bBROKER\s+SCHEMA\s+([A-Za-z0-9_.]+)/i;

function samePosition(a: Range, b: Range): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

/** Order ranges the way LSP expects (document order). */
function byPosition(a: Range, b: Range): number {
  return a.start.line - b.start.line || a.start.character - b.start.character;
}

/** Deduplicate + sort, so repeated hits never show twice. */
function normalize(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of ranges.sort(byPosition)) {
    if (!out.length || !samePosition(out[out.length - 1], r)) out.push(r);
  }
  return out;
}

/** Is `line`/`character` inside `range` (end inclusive)? */
export function rangeContains(range: Range, line: number, character: number): boolean {
  if (line < range.start.line || line > range.end.line) return false;
  if (line === range.start.line && character < range.start.character) return false;
  if (line === range.end.line && character > range.end.character) return false;
  return true;
}

function eqName(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** The identifier under the cursor on the masked view, or null. */
/**
 * Does `word` name (part of) a dotted schema id?
 *
 * The cursor lookup stops at dots, so a reader on `MySchema` inside
 * `BROKER SCHEMA com.example.MySchema` has to match the last segment — otherwise
 * the schema declaration is the one name in the file nothing can be asked about
 * (ISSUES.md I-11). Shared by hover, definition and references.
 */
export function matchesSchemaName(schemaName: string, word: string): boolean {
  const w = word.toUpperCase();
  const dotted = schemaName.toUpperCase();
  return dotted === w || dotted.split('.').some((seg) => seg === w);
}

/**
 * The word under the cursor, including a double-quoted name.
 *
 * The mask erases `"…"` bodies — right for every other pattern, wrong for
 * navigation: a quoted declare name (`DECLARE "script-encoded-hostname"
 * EXTERNAL CHARACTER;`) had no word at its own position, so definition,
 * references and hover all came back empty for a name the outline lists
 * (ISSUES.md I-10). The scanner's quoted-identifier TOKENS answer that
 * (list.md issue 6 / enhancement 20): real `"…"` spans only — never a `"…"`
 * inside a comment or a `'…'` string, and `""` escapes collapse to one
 * character. Shared with hover.ts so all three agree on what the cursor is on.
 */
export function wordAtPosition(
  maskedLines: string[],
  rawLines: string[],
  line: number,
  character: number,
  quoted: QuotedToken[]
): { word: string; range: Range } | null {
  const maskedLine = maskedLines[line];
  if (maskedLine === undefined) return null;
  const w = wordAt(maskedLine, character);
  if (w) {
    return {
      word: w.word,
      range: Range.create(line, w.start, line, w.end),
    };
  }

  for (const t of quoted) {
    if (t.line !== line) continue;
    // The quotes count as "on" the name: a cursor resting on either one
    // still asks about the identifier.
    if (character >= t.startCol && character <= t.endCol) {
      return {
        word: t.value,
        // The name without its quotes, which is what the declaration records.
        range: Range.create(line, t.startCol + 1, line, t.endCol - 1),
      };
    }
  }
  return null;
}

// ─── Fallback extraction (no grammar) ────────────────────────────────────────

/**
 * A CALL target read from the masked text: the routine name a dotted call
 * names plus the qualifier segments that say WHERE that routine lives
 * (list.md issue 3 / issue 5 — a routine's identity is module + name, not
 * the last word alone).
 */
export interface CallTarget {
  /** The routine the call names (last dotted segment). */
  name: string;
  /** Qualifier segments left of the name, source order (e.g. schema, module). */
  qualifier: string[];
  /** True when the cursor sits on the name segment itself. */
  cursorOnName: boolean;
}

const CALL_DOTTED_RE = /\bCALL\s+([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)*)\s*\(/gi;

/** One `CALL <dotted>(` region, segments with their masked string spans. */
interface CallRegion {
  segments: { name: string; from: number; to: number }[];
}

function callRegions(masked: string): CallRegion[] {
  const out: CallRegion[] = [];
  CALL_DOTTED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_DOTTED_RE.exec(masked)) !== null) {
    const groupStart = m.index + m[0].indexOf(m[1]);
    const segs: { name: string; from: number; to: number }[] = [];
    const re = /[A-Za-z_][\w]*/g;
    let s: RegExpExecArray | null;
    while ((s = re.exec(m[1])) !== null) {
      segs.push({ name: s[0], from: groupStart + s.index, to: groupStart + s.index + s[0].length });
    }
    out.push({ segments: segs });
  }
  return out;
}

/**
 * EVERY `CALL <name>(` / `CALL mod.<name>(` site for one routine name in this
 * file, as {qualifier, range-of-name-segment}. The qualifier-qualified truth
 * about WHO each site calls (list.md issue 3/5), readable in both modes
 * because the mask preserves offsets.
 */
export function callSitesForName(
  source: string,
  name: string
): Array<{ qualifier: string[]; range: Range }> {
  const { masked } = scan(source);
  const starts = rowStartsOf(masked);
  const up = name.toUpperCase();
  const out: Array<{ qualifier: string[]; range: Range }> = [];
  for (const region of callRegions(masked)) {
    const last = region.segments[region.segments.length - 1];
    if (last.name.toUpperCase() !== up) continue;
    out.push({
      qualifier: region.segments.slice(0, -1).map((s) => s.name),
      range: indexRange(starts, last.from, last.to),
    });
  }
  return out;
}

/** Range (line/character) of a string-index span, from precomputed row starts. */
function indexRange(starts: number[], from: number, to: number): Range {
  const point = (idx: number): { line: number; character: number } => {
    let line = starts.length - 1;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] > idx) {
        line = i - 1;
        break;
      }
    }
    return { line, character: idx - starts[line] };
  };
  const s = point(from);
  const e = point(to);
  return Range.create(s.line, s.character, e.line, e.character);
}

/**
 * Does this position sit on a `CALL a.b.c(` target's dotted name, and what
 * does that call resolve to? Message-tree paths (`OutputRoot.JSON.Data`)
 * are NOT CALL targets — only the name after the CALL keyword is. A quoted
 * target (`CALL "name"(`) masks away and simply never matches: the caller
 * keeps its existing behavior for it.
 */
export function callTargetAt(source: string, line: number, character: number): CallTarget | null {
  const { masked } = scan(source);
  const starts = rowStartsOf(source);
  if (line < 0 || line >= starts.length) return null;
  const offset = starts[line] + character;
  for (const region of callRegions(masked)) {
    const first = region.segments[0];
    const last = region.segments[region.segments.length - 1];
    if (offset < first.from || offset > last.to) continue;
    const hit = region.segments.find((seg) => offset >= seg.from && offset <= seg.to);
    if (!hit) return null; // whitespace between segments: no word there anyway
    return {
      name: last.name,
      qualifier: region.segments.slice(0, -1).map((seg) => seg.name),
      cursorOnName: hit === last,
    };
  }
  return null;
}

/** String index where each line of `text` starts (client line conventions). */
function rowStartsOf(text: string): number[] {
  const starts = [0];
  const re = /\r\n|\r|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) starts.push(m.index + m[0].length);
  return starts;
}

/** Does `qualifier` name the module `moduleName`? (any segment may carry it) */
export function qualifierMatchesModule(qualifier: string[], moduleName: string): boolean {
  if (!qualifier.length || !moduleName) return false;
  const up = moduleName.toUpperCase();
  return qualifier.some((seg) => seg.toUpperCase() === up);
}

/**
 * The routines THIS file declares that the qualified call names: same name
 * AND owned (by span containment) by a module the qualifier spells. Used by
 * definition, references and hover so the three agree on which routine a
 * dotted CALL means (they disagree visibly when they don't).
 */
export function moduleOwnedRoutines(
  source: string,
  doc: DocAnalysis | undefined,
  call: CallTarget
): Array<{ name: string; range: Range }> {
  const routines: Array<{ name: string; range: Range }> = doc
    ? (doc.routines as Array<{ name: string; range: Range }>)
    : routinesFromSource(source);
  const modules: Array<{ name: string; range: Range }> = doc
    ? (doc.modules as Array<{ name: string; range: Range }>)
    : modulesFromSource(source);
  return routines.filter(
    (r) =>
      eqName(r.name, call.name) &&
      modules.some(
        (m) =>
          qualifierMatchesModule(call.qualifier, m.name) &&
          rangeContains(m.range, r.range.start.line, r.range.start.character)
      )
  );
}

/**
 * A routine declaration as the qualification logic sees it — the shape both
 * extraction paths produce (tree `RoutineInfo` and the heuristic one agree).
 */
export interface RoutineDecl {
  name: string;
  range: Range;
  moduleName?: string;
}

/** Routine declarations from the shared extractor pair (tree first, pattern fallback). */
function routineDecls(source: string, doc?: DocAnalysis): RoutineDecl[] {
  return (doc ? doc.routines : routinesFromSource(source)) as RoutineDecl[];
}

/** Module spans from the shared extractor pair. */
function moduleSpansForRefs(source: string, doc?: DocAnalysis): Array<{ name: string; range: Range }> {
  return (doc ? doc.modules : modulesFromSource(source)) as Array<{ name: string; range: Range }>;
}

/**
 * Which routine declaration(s) the cursor's use of `name` means
 * (issue 3 / issue 5, the file-local mirror of the workspace filter):
 *  - a QUALIFIED call (`CALL Alpha.Helper(`) means the routine the qualifier's
 *    module owns — never a same-named routine living elsewhere;
 *  - an UNQUALIFIED call sitting inside a module that owns a candidate means
 *    that candidate (module-local resolution, which is why one module's call
 *    site is not a reference to another module's routine);
 *  - an unqualified call no candidate's module owns is genuinely AMBIGUOUS —
 *    all candidates are returned, the same answer definition and hover give
 *    (Enh 36: shown, not silently chosen);
 *  - a cursor on a declaration name anchors on THAT declaration.
 */
export function routineTargetsFor(
  source: string,
  line: number,
  character: number,
  name: string,
  atRange: Range,
  doc?: DocAnalysis
): RoutineDecl[] {
  const candidates = routineDecls(source, doc).filter((r) => eqName(r.name, name));
  if (!candidates.length) return [];
  const onDecl = candidates.find((r) => rangeContains(r.range, line, character));
  if (onDecl) return [onDecl];
  const modules = moduleSpansForRefs(source, doc);
  const call = callTargetAt(source, line, character);
  if (call && call.cursorOnName && call.qualifier.length) {
    const owned = moduleOwnedRoutines(source, doc, call);
    return candidates.filter((r) => owned.some((o) => samePosition(o.range, r.range)));
  }
  const owners = candidates.filter((c) => {
    if (!c.moduleName) return false;
    const span = modules.find((m) => eqName(m.name, c.moduleName as string));
    return !!span && rangeContains(span.range, line, character);
  });
  if (owners.length) return owners;
  // Not a call site and not a declaration: a bare use inside a module that
  // owns a candidate resolves there, same rule, else it is ambiguous.
  void atRange;
  return candidates;
}

/**
 * The CALL sites of `anchors` that resolve to them (issue 3/5 + enhancement
 * 17): the sites naming the anchor's module, unqualified sites inside that
 * module, and — where the anchor can be reached without a qualifier —
 * unqualified sites whose module declares nothing by that name. A site no
 * rule can attach to the anchor is a DIFFERENT symbol (a rival module's own
 * call site, or a rival-qualified spelling) and stays out of references,
 * rename and hover alike. Mode-agnostic by construction: the qualifier of
 * every site comes from the CALL-region reader, not from the tree.
 */
export function routineSitesForAnchors(
  source: string,
  anchors: RoutineDecl[],
  doc?: DocAnalysis,
  includeDeclaration = true
): Range[] {
  if (!anchors.length) return [];
  const name = anchors[0].name;
  const modules = moduleSpansForRefs(source, doc);
  const candidates = routineDecls(source, doc).filter((r) => eqName(r.name, name));
  const posKey = (r: Range) => `${r.start.line}:${r.start.character}`;
  const candidatePos = new Set(candidates.map((c) => posKey(c.range)));
  const moduleOwningName = (line: number, character: number) =>
    modules.find(
      (m) =>
        rangeContains(m.range, line, character) &&
        candidates.some(
          (c) => c.moduleName && eqName(c.moduleName, m.name) && rangeContains(m.range, c.range.start.line, c.range.start.character)
        )
    );
  const keep = (range: Range, qualifier: string[]): boolean => {
    for (const a of anchors) {
      if (qualifier.length) {
        if (a.moduleName && qualifierMatchesModule(qualifier, a.moduleName)) return true;
        continue;
      }
      const owner = moduleOwningName(range.start.line, range.start.character);
      if (!owner) return true; // outside any declaring module: ambiguous → a use of every candidate
      if (a.moduleName && eqName(owner.name, a.moduleName)) return true; // the anchor's own module
      // otherwise: the site sits in a module that declares the name itself —
      // it belongs to THAT module's routine, a different symbol.
    }
    return false;
  };
  const out: Range[] = [];
  const seen = new Set<string>();
  const push = (r: Range) => {
    const k = posKey(r);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };
  // CALL regions carry the qualifier context; the plain sweep catches the
  // EXPRESSION call form (`SET total = Round2(a, b)` — a routine use without
  // the CALL keyword) the region reader cannot see. Dotted spellings arrive
  // only through the region reader: the sweep skips dot-adjacent words.
  for (const site of callSitesForName(source, name)) {
    if (keep(site.range, site.qualifier)) push(site.range);
  }
  for (const occ of occurrences(source, name)) {
    if (candidatePos.has(posKey(occ)) && !includeDeclaration) continue; // declaration slot, not a use
    if (keep(occ, [])) push(occ);
  }
  return out;
}

/**
 * The unqualified uses of `name` that NO module can attach to a routine:
 * outside every module that declares the name (declaration slots excluded).
 * Those uses are ambiguous between the same-named routines — a rename of ONE
 * of them would silently retarget them at a rival, which is what the
 * module-routine rename refusal counts. Mode-agnostic: scanner sweep, not
 * the tree.
 */
export function unqualifiedUnguardedSites(source: string, name: string): Range[] {
  const modules = modulesFromSource(source);
  const candidates = routinesFromSource(source).filter((r) => eqName(r.name, name));
  const posKey = (r: Range) => `${r.start.line}:${r.start.character}`;
  const candidatePos = new Set(candidates.map((c) => posKey(c.range)));
  // The sweep (not the CALL-region reader) so the EXPRESSION call form counts
  // too; it skips dot-adjacent words, which is exactly the "spelled a module"
  // exclusion this check needs.
  return occurrences(source, name).filter(
    (occ) =>
      !candidatePos.has(posKey(occ)) &&
      !modules.some(
        (m) =>
          rangeContains(m.range, occ.start.line, occ.start.character) &&
          candidates.some(
            (c) =>
              c.moduleName &&
              eqName(c.moduleName, m.name) &&
              rangeContains(m.range, c.range.start.line, c.range.start.character)
          )
      )
  );
}

/** Whole-file range used as the declaration scope when scoping is unknown. */
function fileScope(lines: string[]): Range {
  return Range.create(0, 0, Math.max(0, lines.length - 1), 0);
}

/** A slice of one line, with the line/column its first character sits at. */
interface Segment {
  line: number;
  start: number;
  text: string;
}

/**
 * The inside of a routine's parameter list, as one segment per line: the header
 * line from the opening paren, then each following line up to and including the
 * one holding the closing paren. Returns null when the line does not open a
 * header, and stops early on structurally impossible input so a stray `(` in a
 * malformed buffer cannot run away.
 */
function paramSegments(lines: string[], lineIdx: number): Segment[] | null {
  const line = lines[lineIdx];
  const header = /\bCREATE\s+(?:FUNCTION|PROCEDURE)\s+[A-Za-z_]\w*\s*\(/gi.exec(line);
  if (!header) return null;
  const openCol = header.index + header[0].length - 1;

  const segments: Segment[] = [];
  const openLineRest = line.slice(openCol + 1);
  const closeOnOpenLine = openLineRest.indexOf(')');
  if (closeOnOpenLine >= 0) {
    return [{ line: lineIdx, start: openCol + 1, text: openLineRest.slice(0, closeOnOpenLine) }];
  }
  segments.push({ line: lineIdx, start: openCol + 1, text: openLineRest });

  for (let j = lineIdx + 1; j < Math.min(lines.length, lineIdx + 40); j++) {
    const next = lines[j];
    if (MODULE_RE.test(next) || /\bEND\s+MODULE\b/i.test(next)) break;
    const close = next.indexOf(')');
    if (close >= 0) {
      segments.push({ line: j, start: 0, text: next.slice(0, close) });
      return segments;
    }
    segments.push({ line: j, start: 0, text: next });
  }
  // No closing paren at all: the buffer is mid-edit. Keep what we gathered —
  // parameters already typed are worth reporting.
  return segments;
}

/** Split a parameter list on commas that are not inside nested parens. */
function splitParams(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Find `name` as a whole word in `text` at or after `from`, else -1. */
function wordIndex(text: string, name: string, from: number): number {
  let at = text.indexOf(name, from);
  while (at >= 0) {
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + name.length] ?? '';
    if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) return at;
    at = text.indexOf(name, at + 1);
  }
  return -1;
}

/** A routine parameter, located. */
export interface LocatedParam {
  name: string;
  constant: boolean;
  type?: string;
  line: number;
  character: number;
}

/**
 * Every routine parameter in the file with its position, whether the list sits
 * on one line or spans several:
 *
 *     CREATE FUNCTION getPolicyProperty(
 *         IN policyName   CHARACTER,
 *         IN propertyName CHARACTER)
 *     RETURNS CHARACTER
 *
 * The previous single-line pattern never saw a list that was not closed on the
 * header line, so such a routine got no parameter symbols at all — outline,
 * hover, definition and the undeclared-variable check all missed them
 * (ISSUES.md I-5).
 */
export function locatedRoutineParams(maskedLines: string[]): LocatedParam[] {
  const out: LocatedParam[] = [];
  for (let i = 0; i < maskedLines.length; i++) {
    const segments = paramSegments(maskedLines, i);
    if (!segments || !segments.length) continue;
    const joined = segments.map((s) => s.text).join(' ');
    if (!joined.trim()) continue;

    // Cursor into the segment list, advanced as names are found so repeated
    // and prefix-like names (`a`, `a2`) each land on their own occurrence.
    let seg = 0;
    let cursor = 0;
    for (const part of splitParams(joined)) {
      const m = PARAM_PART_RE.exec(part);
      if (!m || !m[1]) continue;
      const name = m[1];
      let found = -1;
      while (seg < segments.length) {
        found = wordIndex(segments[seg].text, name, cursor);
        if (found >= 0) break;
        seg++;
        cursor = 0;
      }
      if (found < 0) break;
      out.push({
        name,
        constant: Boolean(m[2]),
        type: m[3],
        line: segments[seg].line,
        character: segments[seg].start + found,
      });
      cursor = found + name.length;
    }
  }
  return out;
}

/**
 * Line ranges of every `CREATE FUNCTION/PROCEDURE` statement found by pattern —
 * the same spans `routinesFromSource()` reports as `declRange`, without the
 * parameter and return-type work, because the scope pass only needs the extent.
 *
 * A body that never closes (the normal state of a buffer while it is being
 * typed) extends to EOF: the alternative would make every declaration in that
 * body invisible, which is the opposite of what a fallback should do. Same rule
 * the module fallback uses for a missing `END MODULE`.
 */
function routineSpans(lines: string[]): Range[] {
  const out: Range[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FN_RE.test(lines[i])) continue;
    const bodyEnd = findBodyEndLine(lines, i);
    const end = bodyEnd <= i ? lines.length - 1 : bodyEnd;
    out.push(Range.create(i, 0, end, (lines[end] ?? '').length));
  }
  return out;
}

/**
 * The narrowest of `spans` that contains `line`, or `outer` when none does
 * (module-level and `BROKER SCHEMA`-level declarations, which the heuristics
 * cannot attribute to a block).
 */
function innermostSpan(spans: Range[], line: number, outer: Range): Range {
  let best: Range | undefined;
  for (const s of spans) {
    if (line < s.start.line || line > s.end.line) continue;
    if (!best || s.end.line < best.end.line) best = s;
  }
  return best ?? outer;
}

/**
 * Scope for a declaration that no routine covers: the module it sits in, so a
 * name declared in a module header stops being visible past `END MODULE` the way
 * the parse tree says it does. A module with no `END MODULE` reaches EOF, which
 * keeps the generous behaviour a buffer being typed needs.
 */
function moduleScope(
  modules: Array<{ name: string; start: number; end: number }>,
  lines: string[],
  line: number,
  outer: Range
): Range {
  let best: { start: number; end: number } | undefined;
  for (const m of modules) {
    if (line < m.start || line > m.end) continue;
    if (!best || m.start > best.start) best = m;
  }
  return best
    ? Range.create(best.start, 0, best.end, (lines[best.end] ?? '').length)
    : outer;
}

/**
 * DECLARED from masked lines: every name of a (possibly multi-name) DECLARE,
 * every routine parameter (single- or multi-line list), and the quoted-name
 * declare form. Ranges cover the name only.
 *
 * `scope` is the enclosing routine's statement when the heuristics can see one
 * (`routineSpans`), otherwise the enclosing module (`moduleScope`), otherwise the
 * file: they have no block model, so a declaration they cannot attribute to a
 * block stays visible for the whole enclosing statement. That is deliberately
 * generous — completion and hover show a name a little too widely rather than
 * hiding one that is legal.
 */
export function declarationsFromSource(source: string): DeclaredName[] {
  const { lines, rawLines } = scan(source);
  const out: DeclaredName[] = [];
  const outer = fileScope(lines);
  const spans = routineSpans(lines);
  const modules = moduleSpans(lines);
  const scopeOf = (line: number) =>
    innermostSpan(spans, line, moduleScope(modules, lines, line, outer));
  // One pass for all parameters (their list may span lines), then emitted at
  // the line each name actually sits on.
  const params = locatedRoutineParams(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A quoted declare name is blanked by the mask, so it is matched on the raw
    // line — but only when the masked view agrees that this `DECLARE` is live
    // code, and the generic pattern below is skipped so `EXTERNAL` is never
    // mistaken for the name (ISSUES.md I-10). The range is the name itself,
    // without the quotes, so it matches what the cursor lookup finds.
    const rawQuoted = QUOTED_DECLARE_RE.exec(rawLines[i] ?? '');
    if (rawQuoted && /\bDECLARE\b/i.test(line)) {
      const escaped = rawQuoted[1]; // still "" -escaped, as it sits in the file
      const name = unquoteESQLName(escaped);
      const type = rawQuoted[3];
      const raw = rawLines[i] ?? '';
      const col = raw.indexOf(`"${escaped}"`) + 1;
      out.push({
        name,
        detail: type ? type.toUpperCase() : 'declared',
        range: Range.create(i, col, i, col + name.length),
        kind: 'variable',
        constant: rawQuoted[2]?.toUpperCase() === 'CONSTANT',
        // SHARED is what the workspace index looks for (ISSUES.md I-13);
        // the masked line (comments blanked) is the evidence.
        shared: /\bSHARED\b/i.test(line),
        scope: scopeOf(i),
      });
      continue;
    }

    const decl = DECLARE_RE.exec(line);
    if (decl) {
      const constant = /\bCONSTANT\b/i.test(line);
      const shared = /\bSHARED\b/i.test(line);
      const detail = `${constant ? 'CONSTANT ' : ''}${decl[2].toUpperCase()}`;
      let searchFrom = 0;
      for (const rawName of decl[1].split(',')) {
        const name = rawName.trim();
        const col = Math.max(decl.index, line.indexOf(name, searchFrom));
        searchFrom = col + name.length;
        out.push({
          name,
          detail,
          range: Range.create(i, col, i, col + name.length),
          kind: 'variable',
          constant,
          shared,
          scope: scopeOf(i),
        });
      }
    }

    for (const p of params.filter((candidate) => candidate.line === i)) {
      out.push({
        name: p.name,
        detail: p.type ? `parameter ${p.type.toUpperCase()}` : 'parameter',
        range: Range.create(p.line, p.character, p.line, p.character + p.name.length),
        kind: 'parameter',
        constant: p.constant,
        scope: scopeOf(p.line),
      });
    }
  }
  return out;
}

/**
 * The line that closes the BEGIN block opened at or after `fromLine`, counting
 * nested blocks so a handler's `BEGIN … END` does not end the routine early.
 * Stops at another top-level declaration as a guard on malformed input.
 */
function findBodyEndLine(lines: string[], fromLine: number): number {
  let depth = 0;
  let started = false;
  for (let j = fromLine; j < lines.length; j++) {
    const line = lines[j];
    if (findBeginToken(line) >= 0) {
      started = true;
      depth++;
    }
    if (findEndToken(line) >= 0 && started) {
      depth--;
      if (depth === 0) return j;
    }
    if (j > fromLine && (MODULE_RE.test(line) || END_MODULE_RE.test(line))) break;
  }
  return fromLine;
}

/** Module name and the lines its statement covers, from masked lines (a module
 * with no `END MODULE` owns everything below it, as in `modulesFromSource`). */
function moduleSpans(lines: string[]): Array<{ name: string; start: number; end: number }> {
  const out: Array<{ name: string; start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = MODULE_RE.exec(lines[i]);
    if (!m) continue;
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (END_MODULE_RE.test(lines[j])) {
        end = j;
        break;
      }
    }
    out.push({ name: m[2], start: i, end });
  }
  return out;
}

/** The module a routine header belongs to: the innermost (last-starting) one. */
function owningModule(
  modules: Array<{ name: string; start: number; end: number }>,
  line: number
): string | undefined {
  let found: { name: string; start: number } | undefined;
  for (const m of modules) {
    if (line < m.start || line > m.end) continue;
    if (!found || m.start > found.start) found = m;
  }
  return found?.name;
}

/**
 * Bare-word SET targets found by pattern (no grammar): every `SET name =`
 * that targets a bare identifier. A DOTTED target (`SET a.b = …`) is a
 * message-tree path, not a variable — the lookahead is part of the contract,
 * not decoration.
 *
 * The single home of this rule (the E-6 one-extractor discipline): the
 * heuristic undeclared check reads it, and the grammar path's mining of
 * damaged regions (CODE_REVIEW.md E-2) reads it — a second copy could only
 * ever drift, and which spelling looks like a variable is exactly the kind
 * of fact two paths must not disagree about.
 */
export function bareTargetsFromSource(source: string): SetTarget[] {
  const { lines } = scan(source);
  const out: SetTarget[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SET_TARGET_RE.exec(lines[i]);
    if (!m) continue;
    const name = m[1];
    const col = lines[i].indexOf(name, m.index);
    out.push({ name, range: Range.create(i, col, i, col + name.length) });
  }
  return out;
}

/**
 * CREATE FUNCTION/PROCEDURE headers found by pattern (no grammar), with the
 * parameter list and return type collected across the lines a split header
 * spans. `documentSymbols()` reads this too, so the outline and go-to-definition
 * cannot disagree about a routine's shape.
 */
export function routinesFromSource(source: string): RoutineInfo[] {
  const { lines, rawLines } = scan(source);
  const out: RoutineInfo[] = [];
  const modules = moduleSpans(lines);

  for (let i = 0; i < lines.length; i++) {
    const m = FN_RE.exec(lines[i]);
    if (!m) continue;
    const kind = m[1].toUpperCase() as 'FUNCTION' | 'PROCEDURE';
    const name = m[2];
    const col = lines[i].indexOf(name, m.index + 'CREATE'.length);
    let bodyEnd = findBodyEndLine(lines, i);

    // An unclosed body — a BEGIN with no matching END; — is the buffer being
    // typed, and the tree-sitter recovery for exactly that buffer keeps the
    // routine owning the rest of its module. Collapse the span to the header
    // here and the outline nests body DECLAREs under the module in heuristic
    // mode but under the routine in grammar mode (ISSUES.md I-6), so extend
    // it to the module's end the same way `modulesFromSource` extends an
    // unclosed module to EOF. A body that never began (EXTERNAL NAME clause)
    // keeps the header-only span.
    if (bodyEnd === i) {
      const span = modules.find((mo) => i >= mo.start && i <= mo.end);
      const boundary = span ? span.end : lines.length - 1;
      let began = false;
      for (let j = i; j <= boundary; j++) {
        if (findBeginToken(lines[j]) >= 0) {
          began = true;
          break;
        }
      }
      if (began) bodyEnd = boundary;
    }

    // Parameters: the header line when the list closes there, otherwise every
    // line the list spans (ISSUES.md I-5).
    let params = (m[4] ?? '').replace(/\s+/g, ' ').trim();
    if (!params) {
      const segments = paramSegments(lines, i);
      if (segments) params = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    }

    // RETURNS: on the header line, or after a split list. Looking only as far
    // as the body keeps a `RETURNS` inside a nested routine out of reach.
    let returnType = m[6] ? m[6].toUpperCase() : undefined;
    if (!returnType) {
      const headerEnd = findBeginToken(lines[i]) >= 0 ? i : findBodyEndLine(lines, i);
      const headerText = lines.slice(i, headerEnd + 1).join(' ');
      const ret = /\bRETURNS\s+([A-Za-z_]\w*)/i.exec(headerText);
      if (ret) returnType = ret[1].toUpperCase();
    }

    out.push({
      name,
      kind,
      params,
      returnType,
      range: Range.create(i, col, i, col + name.length),
      declRange: Range.create(i, 0, bodyEnd, (lines[bodyEnd] ?? '').length),
      // Which module this header sits in: hover says "in module `X`" from this
      // field, and the fallback used to leave it empty, so the same hover lost
      // its owner line in heuristic mode (I-15). Innermost when nested.
      moduleName: owningModule(modules, i),
    });
  }
  return out;
}

/** Module names found by pattern (no grammar). */
/**
 * `CREATE … MODULE name` headers found by pattern, shaped like the grammar's
 * `ModuleInfo` so hover and the outline describe a module the same way in both
 * modes. A module with no `END MODULE` owns everything below it, which is the
 * state of a buffer while it is being typed.
 */
export function modulesFromSource(
  source: string
): Array<{ name: string; kind: string; range: Range; nameRange: Range }> {
  const { lines, rawLines } = scan(source);
  const out: Array<{ name: string; kind: string; range: Range; nameRange: Range }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = MODULE_RE.exec(lines[i]);
    if (!m) continue;
    const col = lines[i].indexOf(m[2], m.index);
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (END_MODULE_RE.test(lines[j])) {
        end = j;
        break;
      }
    }
    out.push({
      name: m[2],
      kind: m[1].toUpperCase(),
      range: Range.create(i, 0, end, (lines[end] ?? '').length),
      nameRange: Range.create(i, col, i, col + m[2].length),
    });
  }
  return out;
}

/** The file's `BROKER SCHEMA` declaration, if any. */
export function schemaFromSource(source: string): { name: string; range: Range } | undefined {
  const { lines, rawLines } = scan(source);
  for (let i = 0; i < lines.length; i++) {
    const m = BROKER_RE.exec(lines[i]);
    if (!m) continue;
    const col = lines[i].indexOf(m[1], m.index);
    return { name: m[1], range: Range.create(i, col, i, col + m[1].length) };
  }
  return undefined;
}

/**
 * Whole-word occurrences of `name` that are NOT part of a dotted path
 * (`OutputRoot.JSON.Data` never matches `Data`) — references without a tree.
 * Exported for the server's cross-file reference scan (CODE_REVIEW.md G-3):
 * same-file and sibling-file occurrence lists are then built by ONE finder.
 */
export function occurrences(source: string, name: string): Range[] {
  const { lines, quotedTokens } = scan(source);
  const out: Range[] = [];
  const re = /[_a-zA-Z][_a-zA-Z0-9]*/g;
  let m: RegExpExecArray | null;
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    while ((m = re.exec(lines[i])) !== null) {
      if (m[0].toUpperCase() !== name.toUpperCase()) continue;
      const before = lines[i].slice(0, m.index);
      const after = lines[i].slice(m.index + m[0].length);
      if (before.endsWith('.') || after.startsWith('.')) continue;
      out.push(Range.create(i, m.index, i, m.index + m[0].length));
    }
  }

  // Quoted spellings are the SAME name to ESQL (`"the-name"` names `the-name`,
  // `"a""b"` names `a"b`). The scanner's tokens carry value + range already
  // normalized (list.md issue 6 / enhancement 20) — no raw-line regex that a
  // comment or a `'…'` string could fool.
  for (const t of quotedTokens) {
    if (t.value.toUpperCase() !== name.toUpperCase()) continue;
    out.push(Range.create(t.line, t.startCol + 1, t.line, t.endCol - 1));
  }
  out.sort((a, b) => a.start.line - b.start.line || a.start.character - b.start.character);
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * The declaration that a position actually sees, innermost scope first. Used by
 * `definitionAt`, by hover (I-15) and by completion (I-16): three features that
 * must agree, because they are asked about the same cursor and the user notices
 * immediately when they do not.
 */
export function visibleDeclarationsAt(
  declarations: DeclaredName[],
  line: number,
  character: number
): DeclaredName[] {
  return declarations
    .filter((d) => rangeContains(d.scope, line, character))
    .sort(rangeEndsBefore);
}

/** Narrowest scope first: a routine body ends before its module does. */
function rangeEndsBefore(a: DeclaredName, b: DeclaredName): number {
  return (
    a.scope.end.line - b.scope.end.line ||
    a.scope.end.character - b.scope.end.character ||
    b.scope.start.line - a.scope.start.line
  );
}

/**
 * The declaration a position RESOLVES to: the innermost same-named
 * declaration whose scope covers it (shadowing order), or null when no
 * declaration reaches it. Declarations of ONE name only — the caller has
 * already filtered (enhancement 16's question at file scale).
 */
function resolveAmong(declarations: DeclaredName[], line: number, character: number): DeclaredName | null {
  const covering = declarations.filter((d) => rangeContains(d.scope, line, character));
  covering.sort(rangeEndsBefore);
  return covering.length ? covering[0] : null;
}

/**
 * Which declaration the cursor points at: the one whose NAME it sits on (a
 * click on a declaration is about THAT declaration, even when an outer
 * sibling shares the name), else what the position resolves to.
 */
function anchorDeclaration(declarations: DeclaredName[], at: Range): DeclaredName | null {
  const onName = declarations.find(
    (d) =>
      rangeContains(d.range, at.start.line, at.start.character) ||
      rangeContains(d.range, at.end.line, at.end.character)
  );
  if (onName) return onName;
  return resolveAmong(declarations, at.start.line, at.start.character);
}

/** Does `use` resolve to `anchor` (rather than to a shadowing sibling)? */
function resolvesToAnchor(
  use: Range,
  declarations: DeclaredName[],
  anchor: DeclaredName | null
): boolean {
  if (!anchor) return false;
  return resolveAmong(declarations, use.start.line, use.start.character) === anchor;
}

/**
 * The declaration(s) at the NARROWEST scope among `decls` — all of them when
 * they tie (two declarations sharing one scope is a genuine duplicate, and
 * the reader should see both; one winner when one scope is strictly inside
 * the others, i.e. the shadowing order).
 */
function narrowestScope(decls: DeclaredName[]): DeclaredName[] {
  if (!decls.length) return [];
  const sorted = decls.slice().sort(rangeEndsBefore);
  const best = sorted[0].scope;
  return decls.filter(
    (d) =>
      d.scope.start.line === best.start.line &&
      d.scope.start.character === best.start.character &&
      d.scope.end.line === best.end.line &&
      d.scope.end.character === best.end.character
  );
}

/**
 * The declaration of `name` that a position refers to — the one whose `scope`
 * contains the position, innermost first, so a routine's own `DECLARE` wins over
 * a same-named one in an earlier routine. When the cursor already sits on a
 * declaration of that name, that declaration answers (a definition request on a
 * declaration must not jump elsewhere). Only when no declaration of the name is
 * in scope do the candidates come back in file order, so a name declared in an
 * outer module, or one the recovery pass placed somewhere unexpected, still
 * resolves rather than silently answering nothing.
 */
export function declarationAt(
  declarations: DeclaredName[],
  name: string,
  line: number,
  character: number
): DeclaredName | undefined {
  const named = declarations.filter((d) => eqName(d.name, name));
  if (!named.length) return undefined;
  const here = named.find((d) => rangeContains(d.range, line, character));
  if (here) return here;
  const inScope = visibleDeclarationsAt(named, line, character);
  return inScope.length ? inScope[0] : named[0];
}

/**
 * The routine a position is inside — the innermost one whose statement (header
 * plus body) covers it. Not a lookup *of* a routine by name: this is the answer
 * to "who owns this line", which is what a declaration's owner line needs.
 */
export function enclosingRoutine(
  routines: RoutineInfo[],
  line: number,
  character: number
): RoutineInfo | undefined {
  const around = routines.filter((r) =>
    rangeContains(r.declRange ?? r.range, line, character)
  );
  if (!around.length) return undefined;
  return around.reduce((inner, r) =>
    (r.declRange ?? r.range).start.line > (inner.declRange ?? inner.range).start.line
      ? r
      : inner
  );
}

/**
 * The routine to hover when the word under the cursor is a routine *name*: the
 * one with that name which the cursor belongs to, when there is one — a file
 * with two modules each holding a `Main()` must not hover the second module's
 * `Main` as if it were the first's (I-15). Falls back to file order.
 */
export function routineByNameAt(
  routines: RoutineInfo[],
  name: string,
  line: number,
  character: number
): RoutineInfo | undefined {
  const named = routines.filter((r) => eqName(r.name, name));
  if (!named.length) return undefined;
  const owner = enclosingRoutine(routines, line, character);
  if (owner && named.includes(owner)) return owner;
  return named[0];
}

/**
 * Declaration ranges for the symbol under the cursor; empty when the word is
 * a built-in, a message-tree path element, or simply undeclared.
 */
export function definitionAt(
  source: string,
  line: number,
  character: number,
  doc?: DocAnalysis
): Range[] {
  const { lines, rawLines, quotedTokens } = scan(source);
  const at = wordAtPosition(lines, rawLines, line, character, quotedTokens);
  if (!at) return [];

  // G-6: a schema segment is never a routine click. `BROKER SCHEMA
  // com.acme.main` next to `CREATE FUNCTION Main()` used to answer a click on
  // `main` with the ROUTINE — two different names the dotted lookup happens
  // to spell the same. Inside a schema name only the schema may answer.
  // (Definition only — hover resolves differently and the review measured no
  // hover mis-jump here.)
  const cursorInSchema = (schemas: { range: Range }[]): boolean =>
    schemas.some((s) => rangeContains(s.range, line, character));

  // Issue 3 / issue 5: a CALL that spells its module (`CALL Sales.Util(`)
  // names the OWNER as well as the routine — a same-named routine living in
  // a different module is a different symbol and must not answer. Shared by
  // both modes; the workspace half applies the same filter.
  const call = callTargetAt(source, line, character);
  if (call && call.cursorOnName && call.qualifier.length) {
    const owned = moduleOwnedRoutines(source, doc, call);
    return normalize(owned.map((r) => r.range)); // empty falls through to the workspace
  }

  if (doc) {
    const found: Range[] = [];

    if (!cursorInSchema(doc.schemas)) {
      // The QUALIFIED/owner/ambiguity rules of routineTargetsFor answer the
      // click — not every same-named routine in the file (issue 3/5): two
      // modules each declaring `Helper` are two symbols, and a call inside
      // one of them never means the other.
      for (const t of routineTargetsFor(source, line, character, at.word, at.range, doc)) {
        found.push(t.range);
      }
    }

    const declarations = doc.declaredNames.filter((d) => eqName(d.name, at.word));
    // Cursor already on a declaration: stay there.
    const onDeclaration = declarations.filter((d) => rangeContains(d.range, line, character));
    if (onDeclaration.length) return normalize(onDeclaration.map((d) => d.range));
    // The INNERMOST visible declaration answers (issue 2/17): an outer
    // sibling of the same name is shadowed and stays out — unless the two
    // share the same scope (a real duplicate), then both are shown.
    // If none is in scope (an undeclared name, or a declaration the recovery
    // pass put elsewhere), offer them all rather than nothing.
    const inScope = declarations.filter((d) => rangeContains(d.scope, line, character));
    const chosen = narrowestScope(inScope);
    for (const d of chosen.length ? chosen : declarations) found.push(d.range);

    for (const mod of doc.modules) {
      if (eqName(mod.name, at.word)) found.push(mod.nameRange);
    }
    for (const schema of doc.schemas) {
      if (matchesSchemaName(schema.name, at.word)) found.push(schema.range);
    }
    return normalize(found);
  }

  // ── heuristic mode ──
  const found: Range[] = [];
  const schema = schemaFromSource(source);
  if (!cursorInSchema(schema ? [schema] : [])) {
    for (const t of routineTargetsFor(source, line, character, at.word, at.range, doc)) {
      found.push(t.range);
    }
  }
  const sameName = declarationsFromSource(source).filter((d) => eqName(d.name, at.word));
  // Same innermost-first answer as the tree path (issue 2/17); when nothing
  // covers the cursor, offer them all rather than nothing.
  const covered = sameName.filter((d) => rangeContains(d.scope, line, character));
  const chosen = covered.length ? narrowestScope(covered) : sameName;
  for (const d of chosen) found.push(d.range);
  for (const mod of modulesFromSource(source)) {
    if (eqName(mod.name, at.word)) found.push(mod.nameRange);
  }
  if (schema && matchesSchemaName(schema.name, at.word)) found.push(schema.range);
  return normalize(found);
}

/**
 * All ranges that use the symbol under the cursor. `includeDeclaration`
 * follows `context.includeDeclaration` from the client (default true, like
 * the LSP spec).
 */
export function referencesAt(
  source: string,
  line: number,
  character: number,
  includeDeclaration = true,
  doc?: DocAnalysis
): Range[] {
  const { lines, rawLines, quotedTokens } = scan(source);
  const at = wordAtPosition(lines, rawLines, line, character, quotedTokens);
  if (!at) return [];

  // Issue 3 / issue 5: qualified CALLs resolve through the module too (see
  // definitionAt). The in-file half is one mode-agnostic finder — the call
  // SITES of this name, keeping the ones that mean THIS module's routine:
  // sites that spell the qualifying module, and unqualified sites sitting
  // inside that module (module-local resolution).
  const call = callTargetAt(source, line, character);
  if (call && call.cursorOnName && call.qualifier.length) {
    const owned = moduleOwnedRoutines(source, doc, call);
    const modules = doc ? doc.modules : modulesFromSource(source);
    const sites = callSitesForName(source, call.name).filter((site) =>
      site.qualifier.length
        ? site.qualifier.some((seg) => qualifierMatchesModule(call.qualifier, seg))
        : modules.some(
            (m) =>
              qualifierMatchesModule(call.qualifier, m.name) &&
              rangeContains(m.range, site.range.start.line, site.range.start.character)
          )
    );
    const found: Range[] = sites.map((site) => site.range);
    if (includeDeclaration) for (const r of owned) found.push(r.range);
    return normalize(found);
  }

  if (doc) {
    const routines = routineDecls(source, doc).filter((r) => eqName(r.name, at.word));
    if (routines.length) {
      // Anchored + qualified like the definition: the sites that resolve to
      // the anchor(s) — a sibling module's own call sites and rival-qualified
      // spellings are different symbols and stay out (issue 3/5); the site
      // list is CALL-region-driven, so the tree's dotted-reference list is
      // not consulted here and cannot diverge from the fallback.
      const anchors = routineTargetsFor(source, line, character, at.word, at.range, doc);
      const list = anchors.length ? anchors : routines;
      const found = routineSitesForAnchors(source, list, doc, includeDeclaration);
      if (includeDeclaration) for (const a of list) found.push(a.range);
      return normalize(found);
    }

    const declarations = doc.declaredNames.filter((d) => eqName(d.name, at.word));
    if (declarations.length) {
      // Issue 2 / enhancement 17: the answer is ANCHORED on the declaration
      // the cursor points at, and only the uses that resolve to that one are
      // reported. The previous "widest visibility of any same-named
      // declaration" merged sibling locals — renaming one routine's `total`
      // rewrote another routine's unrelated `total` with it.
      const anchor = anchorDeclaration(declarations, at.range);
      const found = doc.references
        .filter(
          (r) =>
            r.kind === 'variable' &&
            eqName(r.name, at.word) &&
            resolvesToAnchor(r.range, declarations, anchor)
        )
        .map((r) => r.range);
      // The occurrence under the cursor joins only when it resolves to the
      // anchor too: a click on an occurrence NO declaration covers is not a
      // reference to this name, and renaming through it is what this guards.
      const onDeclaration = declarations.some((d) => samePosition(d.range, at.range));
      if (
        anchor &&
        !found.some((r) => samePosition(r, at.range)) &&
        (includeDeclaration || !onDeclaration) &&
        resolvesToAnchor(at.range, declarations, anchor)
      ) {
        found.push(at.range);
      }
      if (anchor && includeDeclaration) found.push(anchor.range);
      return normalize(found);
    }

    // A module name is never "used" inside its own file, so with
    // includeDeclaration off there is nothing left to report.
    const modules = doc.modules.filter((m) => eqName(m.name, at.word));
    if (modules.length) {
      return normalize(includeDeclaration ? modules.map((m) => m.nameRange) : []);
    }

    // Same for the schema declaration: it is named once, by the file itself.
    const schemas = doc.schemas.filter((s) => matchesSchemaName(s.name, at.word));
    if (schemas.length) {
      return normalize(includeDeclaration ? schemas.map((s) => s.range) : []);
    }

    return [];
  }

  // ── heuristic mode ──
  // A word that names a ROUTINE answers with the routine rules — anchored on
  // the declaration(s) the cursor resolves to, keeping the CALL sites that
  // mean them (issue 3/5; the tree path above orders the same way).
  const varDecls = declarationsFromSource(source).filter((d) => eqName(d.name, at.word));
  const routinesPat = routinesFromSource(source).filter((r) => eqName(r.name, at.word));
  if (routinesPat.length) {
    const anchors = routineTargetsFor(source, line, character, at.word, at.range);
    const list = anchors.length ? anchors : routinesPat;
    const found = routineSitesForAnchors(source, list, undefined, includeDeclaration);
    if (includeDeclaration) for (const a of list) found.push(a.range);
    return normalize(found);
  }
  const declarationRanges = varDecls.map((d) => d.range);
  if (!declarationRanges.length) {
    // Nothing declares the word: either a module name (no use sites inside the
    // file, only its declaration) or a built-in / path element, in which case
    // there is no answer rather than a list of unrelated occurrences.
    const modules = modulesFromSource(source).filter((m) => eqName(m.name, at.word));
    const schema = schemaFromSource(source);
    const schemas = schema && matchesSchemaName(schema.name, at.word) ? [schema] : [];
    return normalize(
      includeDeclaration ? [...modules.map((m) => m.nameRange), ...schemas.map((s) => s.range)] : []
    );
  }
  const posKey = (r: Range) => `${r.start.line}:${r.start.character}`;
  const anchor = anchorDeclaration(varDecls, at.range);
  const declared = new Set(declarationRanges.map(posKey));
  const found = occurrences(source, at.word).filter((r) => {
    if (!resolvesToAnchor(r, varDecls, anchor)) return false;
    return includeDeclaration || !declared.has(posKey(r));
  });
  if (anchor && includeDeclaration) found.push(anchor.range);
  return normalize(found);
}

/** Does `outer` fully contain `inner`? */
function rangeCovers(outer: Range, inner: Range): boolean {
  const before =
    outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line && outer.start.character <= inner.start.character);
  const after =
    outer.end.line > inner.end.line ||
    (outer.end.line === inner.end.line && outer.end.character >= inner.end.character);
  return before && after;
}
