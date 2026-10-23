/**
 * ESQL document symbols.
 *
 * Structure:
 *
 *   Namespace (BROKER SCHEMA)
 *   Module          CREATE COMPUTE|FILTER|DATABASE MODULE ... END MODULE
 *     Function      CREATE FUNCTION|PROCEDURE ... (body bounded by BEGIN/END)
 *       Variable    parameter + DECLARE inside the routine body
 *     Variable      module-level DECLARE
 *
 * `documentSymbolsFromTree()` reads the parse tree (exact ranges, every name
 * of a multi-name DECLARE, real nesting) and is what the server uses when the
 * grammar is loaded. `documentSymbols()` is the Phase 1 pattern fallback for
 * environments without the native addon; same shape, coarser edges.
 */

import { DocumentSymbol, Range, SymbolKind } from 'vscode-languageserver';
import { scan } from './scanner';
import {
  rangeContains,
  declarationsFromSource,
  routinesFromSource,
} from './definitions';
import type { DocAnalysis, RoutineInfo } from './parser';

const BROKER_RE = /\bBROKER\s+SCHEMA\s+([A-Za-z0-9_.]+)/i;
const MODULE_RE = /\bCREATE\s+(COMPUTE|FILTER|DATABASE)\s+MODULE\s+([A-Za-z_]\w*)/i;
const END_MODULE_RE = /\bEND\s+MODULE\b/i;

function lineRange(line: number, length: number): Range {
  return Range.create(line, 0, line, length);
}

/**
 * Range of the captured name inside a single-line match.
 *
 * The offset has to be added to the match's own start column: `\bCREATE` on an
 * indented line begins at column 1, so returning `m[0].indexOf(name)` alone put
 * every indented routine's `selectionRange` one character left of the name —
 * which made hover/definition/references fail when asked at the position the
 * outline itself advertised (ISSUES.md I-4).
 */
function nameRange(line: number, name: string, match: RegExpExecArray): Range {
  const idx = match[0].indexOf(name);
  const start = idx >= 0 ? match.index + idx : match.index;
  return Range.create(line, start, line, start + name.length);
}

/** A line span (module or routine) that can own nested symbols. */
interface BlockScope {
  startLine: number;
  endLine: number;
  symbol: DocumentSymbol;
}

export function documentSymbols(source: string): DocumentSymbol[] {
  const { lines } = scan(source);
  const symbols: DocumentSymbol[] = [];
  const modules: BlockScope[] = [];
  const functions: BlockScope[] = [];
  // Routine headers come from the one shared extractor, keyed by header line.
  const routineByHeaderLine = new Map<number, RoutineInfo>();
  for (const r of routinesFromSource(source)) {
    if (!routineByHeaderLine.has(r.range.start.line)) routineByHeaderLine.set(r.range.start.line, r);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── BROKER SCHEMA ────────────────────────────────────────────────────
    const broker = BROKER_RE.exec(line);
    if (broker) {
      symbols.push({
        name: broker[1],
        detail: 'BROKER SCHEMA',
        kind: SymbolKind.Namespace,
        range: lineRange(i, line.length),
        selectionRange: nameRange(i, broker[1], broker),
      });
      continue;
    }

    // ── MODULE ───────────────────────────────────────────────────────────
    const mod = MODULE_RE.exec(line);
    if (mod) {
      // Unclosed module? Then it owns everything below it, which is what the
      // parse tree does with an ERROR region that runs to the end of the file.
      let end = lines.length - 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (END_MODULE_RE.test(lines[j])) {
          end = j;
          break;
        }
      }
      const symbol: DocumentSymbol = {
        name: mod[2],
        detail: `${mod[1].toUpperCase()} MODULE`,
        kind: SymbolKind.Module,
        range: Range.create(i, 0, end, lines[end].length),
        selectionRange: nameRange(i, mod[2], mod),
        children: [],
      };
      symbols.push(symbol);
      modules.push({ startLine: i, endLine: end, symbol });
      continue;
    }

    // ── FUNCTION / PROCEDURE ─────────────────────────────────────────────
    // Headers come from definitions.ts (see the note above), so the outline,
    // hover and go-to-definition cannot disagree about a routine — including
    // one whose parameter list and RETURNS clause span several lines.
    const fn = routineByHeaderLine.get(i);
    if (fn) {
      const symbol: DocumentSymbol = {
        name: fn.name,
        detail: `${fn.kind}(${fn.params})${fn.returnType ? ` RETURNS ${fn.returnType}` : ''}`,
        kind: SymbolKind.Function,
        range: fn.declRange,
        selectionRange: fn.range,
        children: [],
      };
      const owner = modules.find((m) => i > m.startLine && i <= m.endLine);
      if (owner) owner.symbol.children!.push(symbol);
      else symbols.push(symbol);
      functions.push({ startLine: i, endLine: fn.declRange.end.line, symbol });
      continue;
    }
  }

  // ── DECLARES and routine parameters ────────────────────────────────────
  // Shared with definitions.ts, so both paths agree on what is declared —
  // including every name of a multi-name `DECLARE a, b INT;`.
  for (const d of declarationsFromSource(source)) {
    const line = d.range.start.line;
    const symbol: DocumentSymbol = {
      name: d.name,
      detail: d.detail || (d.kind === 'parameter' ? 'parameter' : 'declared'),
      kind: SymbolKind.Variable,
      range: d.range,
      selectionRange: d.range,
    };
    // Nesting is by the routine's declared span, so a parameter written on a
    // continuation line of a split header still lands under its routine.
    const routine = functions.find((f) => line >= f.startLine && line <= f.endLine);
    if (routine) {
      routine.symbol.children!.push(symbol);
      continue;
    }
    const owner = modules.find((m) => line > m.startLine && line <= m.endLine);
    if (owner) owner.symbol.children!.push(symbol);
    else symbols.push(symbol);
  }

  return sortDeep(symbols);
}

/** Document order. */
function byPosition(a: Range, b: Range): number {
  return a.start.line - b.start.line || a.start.character - b.start.character;
}

function sortDeep(symbols: DocumentSymbol[]): DocumentSymbol[] {
  symbols.sort((a, b) => byPosition(a.range, b.range));
  for (const s of symbols) if (s.children?.length) sortDeep(s.children);
  return symbols;
}

/**
 * Symbols from a parse tree: exact module/routine extents, every name of a
 * multi-name `DECLARE`, parameters nested under their routine.
 */
export function documentSymbolsFromTree(doc: DocAnalysis): DocumentSymbol[] {
  const roots: DocumentSymbol[] = [];

  for (const schema of doc.schemas) {
    roots.push({
      name: schema.name,
      kind: SymbolKind.Namespace,
      detail: 'BROKER SCHEMA',
      range: schema.range,
      selectionRange: schema.range,
    });
  }

  const moduleEntries = doc.modules.map((m) => ({
    info: m,
    symbol: {
      name: m.name,
      detail: `${m.kind} MODULE`,
      kind: SymbolKind.Module,
      range: m.range,
      selectionRange: m.nameRange,
      children: [] as DocumentSymbol[],
    } as DocumentSymbol,
  }));

  const routineEntries = doc.routines.map((r) => ({
    info: r,
    symbol: {
      name: r.name,
      detail: `${r.kind}(${r.params})${r.returnType ? ` RETURNS ${r.returnType}` : ''}`,
      kind: SymbolKind.Function,
      range: r.declRange,
      selectionRange: r.range,
      children: [] as DocumentSymbol[],
    } as DocumentSymbol,
  }));

  // Routines nest under the module that contains their header.
  for (const entry of routineEntries) {
    const owner = moduleEntries.find((m) =>
      rangeContains(m.symbol.range, entry.info.declRange.start.line, entry.info.declRange.start.character)
    );
    if (owner) owner.symbol.children!.push(entry.symbol);
    else roots.push(entry.symbol);
  }

  // Declarations nest as deep as their visibility really goes: anything
  // declared for a routine — its parameters *and* its body DECLAREs — lives
  // inside the routine's CREATE..END statement, a module-level DECLARE inside
  // the module. ESQL has no nested routines, so this is unambiguous.
  for (const d of doc.declaredNames) {
    const symbol: DocumentSymbol = {
      name: d.name,
      detail: d.detail || (d.kind === 'parameter' ? 'parameter' : 'declared'),
      kind: SymbolKind.Variable,
      range: d.range,
      selectionRange: d.range,
    };
    const routine = routineEntries.find((entry) =>
      rangeContains(entry.info.declRange, d.range.start.line, d.range.start.character)
    );
    if (routine) {
      routine.symbol.children!.push(symbol);
      continue;
    }
    const module = moduleEntries.find((entry) =>
      rangeContains(entry.symbol.range, d.range.start.line, d.range.start.character)
    );
    if (module) module.symbol.children!.push(symbol);
    else roots.push(symbol);
  }

  for (const entry of moduleEntries) roots.push(entry.symbol);
  return sortDeep(roots);
}
