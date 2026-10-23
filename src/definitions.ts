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
import { scan, wordAt } from './scanner';
import { DECLARE_RE, FN_PARAMS_RE } from './diagnostics';
import type { DocAnalysis, DeclaredName, RoutineInfo } from './parser';

const FN_RE =
  /\bCREATE\s+(FUNCTION|PROCEDURE)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)([\s\S]{0,80}?\bRETURNS\s+([A-Za-z]+))?/i;

/** `CREATE (COMPUTE|FILTER|DATABASE|DATABASEEVENT) MODULE name` (fallback path). */
const MODULE_RE =
  /\bCREATE\s+(COMPUTE|FILTER|DATABASE|DATABASEEVENT)\s+MODULE\s+([A-Za-z_]\w*)/i;

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
function wordAtPosition(
  lines: string[],
  line: number,
  character: number
): { word: string; range: Range } | null {
  const maskedLine = lines[line];
  if (maskedLine === undefined) return null;
  const w = wordAt(maskedLine, character);
  if (!w) return null;
  return {
    word: w.word,
    range: Range.create(line, w.start, line, w.end),
  };
}

// ─── Fallback extraction (no grammar) ────────────────────────────────────────

/** Whole-file range used as the declaration scope when scoping is unknown. */
function fileScope(lines: string[]): Range {
  return Range.create(0, 0, Math.max(0, lines.length - 1), 0);
}

/**
 * DECLARED from masked lines: every name of a (possibly multi-name) DECLARE
 * plus the parameters of the routine on the same line. Ranges cover the name
 * only; the scope is the whole file because the heuristics have no block
 * model.
 */
export function declarationsFromSource(source: string): DeclaredName[] {
  const { lines } = scan(source);
  const out: DeclaredName[] = [];
  const scope = fileScope(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const decl = DECLARE_RE.exec(line);
    if (decl) {
      const constant = /\bCONSTANT\b/i.test(line);
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
          scope,
        });
      }
    }

    const fn = FN_PARAMS_RE.exec(line);
    if (fn && fn[1]) {
      for (const param of fn[1].split(',')) {
        // `[IN|OUT|INOUT] name [CONSTANT] TYPE …` — the fallback sees the
        // header line only, so the type is whatever word follows the name.
        // The mode keyword must be followed by whitespace, or `IN` itself
        // would be captured as the parameter name.
        const m = /^\s*(?:(?:IN|OUT|INOUT)\s+)?([A-Za-z_]\w*)\s*(?:(CONSTANT)\s+)?([A-Za-z]+)?/i.exec(
          param
        );
        if (!m || !m[1]) continue;
        const col = line.indexOf(m[1]);
        out.push({
          name: m[1],
          detail: m[3] ? `parameter ${m[3].toUpperCase()}` : 'parameter',
          range: Range.create(i, col, i, col + m[1].length),
          kind: 'parameter',
          constant: Boolean(m[2]),
          scope,
        });
      }
    }
  }
  return out;
}

/** CREATE FUNCTION/PROCEDURE headers found by pattern (no grammar). */
export function routinesFromSource(source: string): RoutineInfo[] {
  const { lines } = scan(source);
  const out: RoutineInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = FN_RE.exec(lines[i]);
    if (!m) continue;
    const kind = m[1].toUpperCase() as 'FUNCTION' | 'PROCEDURE';
    const name = m[2];
    const col = lines[i].indexOf(name, m.index + 'CREATE'.length);
    // Body end: the next standalone `END` at or after the header line. The
    // heuristic has no nesting model, so a handler block can end it early —
    // acceptable for a fallback, and definition only needs the header.
    let bodyEnd = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (/\bEND\b/i.test(lines[j])) {
        bodyEnd = j;
        break;
      }
    }
    out.push({
      name,
      kind,
      params: (m[3] ?? '').replace(/\s+/g, ' ').trim(),
      returnType: m[5] ? m[5].toUpperCase() : undefined,
      range: Range.create(i, col, i, col + name.length),
      declRange: Range.create(i, 0, bodyEnd, (lines[bodyEnd] ?? '').length),
      moduleName: undefined,
    });
  }
  return out;
}

/** Module names found by pattern (no grammar). */
function modulesFromSource(source: string): { name: string; range: Range }[] {
  const { lines } = scan(source);
  const out: { name: string; range: Range }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = MODULE_RE.exec(lines[i]);
    if (!m) continue;
    const col = lines[i].indexOf(m[2], m.index);
    out.push({ name: m[2], range: Range.create(i, col, i, col + m[2].length) });
  }
  return out;
}

/**
 * Whole-word occurrences of `name` that are NOT part of a dotted path
 * (`OutputRoot.JSON.Data` never matches `Data`) — references without a tree.
 */
function occurrences(source: string, name: string): Range[] {
  const { lines } = scan(source);
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
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────

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
  const { lines } = scan(source);
  const at = wordAtPosition(lines, line, character);
  if (!at) return [];

  if (doc) {
    const found: Range[] = [];

    for (const routine of doc.routines) {
      if (eqName(routine.name, at.word)) found.push(routine.range);
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
    return normalize(found);
  }

  // ── heuristic mode ──
  const found: Range[] = [];
  for (const routine of routinesFromSource(source)) {
    if (eqName(routine.name, at.word)) found.push(routine.range);
  }
  for (const d of declarationsFromSource(source)) {
    if (eqName(d.name, at.word)) found.push(d.range);
  }
  for (const mod of modulesFromSource(source)) {
    if (eqName(mod.name, at.word)) found.push(mod.range);
  }
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
  const { lines } = scan(source);
  const at = wordAtPosition(lines, line, character);
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
    return normalize(includeDeclaration ? modules.map((m) => m.range) : []);
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
