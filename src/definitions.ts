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
import { scan, wordAt, findBeginToken, findEndToken, unquoteESQLName } from './scanner';
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
 * HANDLER …`) declare no variable and are excluded.
 *
 * The type word must not be another flag word: mid-edit `DECLARE x SHARED `
 * (buffer being typed, no datatype yet) then declares NOTHING, which is what
 * the tree path does too — a `declare_statement` without a `datatype` child
 * is the namespace-alias form and is not indexed (CODE_REVIEW.md C-7: without
 * the guard the heuristic indexed x typed `SHARED` and the modes drifted). */
const DECLARE_RE =
  /\bDECLARE\s+(?!CONTINUE\b|EXIT\b)((?:[A-Za-z_]\w*\s*,\s*)*[A-Za-z_]\w*)\s+(?:CONSTANT\s+|SHARED\s+|EXTERNAL\s+)*(?!(?:SHARED|EXTERNAL|CONSTANT)\b)([A-Za-z]+)/i;

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
 * (ISSUES.md I-10). Shared with hover.ts so all three agree on what the cursor
 * is on.
 */
export function wordAtPosition(
  maskedLines: string[],
  rawLines: string[],
  line: number,
  character: number
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

  const rawLine = rawLines[line] ?? '';
  const quoted = /"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(rawLine)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (character >= start && character <= end) {
      return {
        word: m[1],
        // The name without its quotes, which is what the declaration records.
        range: Range.create(line, start + 1, line, end - 1),
      };
    }
  }
  return null;
}

// ─── Fallback extraction (no grammar) ────────────────────────────────────────

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
  const { lines, rawLines } = scan(source);
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

    // Quoted form: `"the-name"` is the same name to ESQL, and the mask erases
    // it, so it has to be looked for in the raw text (range without quotes).
    const quoted = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
    let q: RegExpExecArray | null;
    while ((q = quoted.exec(rawLines[i] ?? '')) !== null) {
      out.push(Range.create(i, q.index + 1, i, q.index + 1 + name.length));
    }
  }
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
  const { lines, rawLines } = scan(source);
  const at = wordAtPosition(lines, rawLines, line, character);
  if (!at) return [];

  // G-6: a schema segment is never a routine click. `BROKER SCHEMA
  // com.acme.main` next to `CREATE FUNCTION Main()` used to answer a click on
  // `main` with the ROUTINE — two different names the dotted lookup happens
  // to spell the same. Inside a schema name only the schema may answer.
  // (Definition only — hover resolves differently and the review measured no
  // hover mis-jump here.)
  const cursorInSchema = (schemas: { range: Range }[]): boolean =>
    schemas.some((s) => rangeContains(s.range, line, character));

  if (doc) {
    const found: Range[] = [];

    if (!cursorInSchema(doc.schemas)) {
      for (const routine of doc.routines) {
        if (eqName(routine.name, at.word)) found.push(routine.range);
      }
    }

    const declarations = doc.declaredNames.filter((d) => eqName(d.name, at.word));
    // Cursor already on a declaration: stay there.
    const onDeclaration = declarations.filter((d) => rangeContains(d.range, line, character));
    if (onDeclaration.length) return normalize(onDeclaration.map((d) => d.range));
    // Prefer the innermost visible declaration; if none is in scope (an
    // undeclared name, or a declaration the recovery pass put elsewhere),
    // offer them all rather than nothing.
    const inScope = declarations.filter((d) => rangeContains(d.scope, line, character));
    for (const d of inScope.length ? inScope : declarations) found.push(d.range);

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
    for (const routine of routinesFromSource(source)) {
      if (eqName(routine.name, at.word)) found.push(routine.range);
    }
  }
  for (const d of declarationsFromSource(source)) {
    if (eqName(d.name, at.word)) found.push(d.range);
  }
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
  const { lines, rawLines } = scan(source);
  const at = wordAtPosition(lines, rawLines, line, character);
  if (!at) return [];

  if (doc) {
    const routines = doc.routines.filter((r) => eqName(r.name, at.word));
    if (routines.length) {
      const found = doc.references
        .filter((r) => r.kind === 'routine' && eqName(r.name, at.word))
        .map((r) => r.range);
      if (includeDeclaration) for (const r of routines) found.push(r.range);
      return normalize(found);
    }

    const declarations = doc.declaredNames.filter((d) => eqName(d.name, at.word));
    if (declarations.length) {
      // Widest visibility of any matching declaration: a module-level
      // DECLARE is readable from every routine body inside it.
      const scope = declarations
        .map((d) => d.scope)
        .reduce((widest, candidate) => (rangeCovers(candidate, widest) ? candidate : widest));
      const found = doc.references
        .filter(
          (r) =>
            r.kind === 'variable' &&
            eqName(r.name, at.word) &&
            rangeContains(scope, r.range.start.line, r.range.start.character)
        )
        .map((r) => r.range);
      // Always include the occurrence under the cursor — a name used in a
      // region the recovery pass dropped still gets found — unless the cursor
      // is on the declaration itself and the client asked for uses only.
      const declarationRanges = declarations.map((d) => d.range);
      const onDeclaration = declarationRanges.some((r) => samePosition(r, at.range));
      if (!found.some((r) => samePosition(r, at.range)) && (includeDeclaration || !onDeclaration)) {
        found.push(at.range);
      }
      if (includeDeclaration) found.push(...declarationRanges);
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
  // The fallback has no use/declaration distinction: it takes every whole-word
  // occurrence that is not a dotted-path part, then adds or strips the
  // declaration ranges depending on `includeDeclaration`.
  const declarationRanges = [
    ...declarationsFromSource(source)
      .filter((d) => eqName(d.name, at.word))
      .map((d) => d.range),
    ...routinesFromSource(source)
      .filter((r) => eqName(r.name, at.word))
      .map((r) => r.range),
  ];
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
  const declared = new Set(declarationRanges.map((r) => `${r.start.line}:${r.start.character}`));
  const found = occurrences(source, at.word).filter(
    (r) => includeDeclaration || !declared.has(`${r.start.line}:${r.start.character}`)
  );
  if (includeDeclaration) found.push(...declarationRanges);
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
