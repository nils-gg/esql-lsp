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
import { scan, findBeginToken, findEndToken } from './scanner';
import { rangeContains, declarationsFromSource } from './definitions';
import type { DocAnalysis } from './parser';

const BROKER_RE = /\bBROKER\s+SCHEMA\s+([A-Za-z0-9_.]+)/i;
const MODULE_RE = /\bCREATE\s+(COMPUTE|FILTER|DATABASE)\s+MODULE\s+([A-Za-z_]\w*)/i;
const END_MODULE_RE = /\bEND\s+MODULE\b/i;
const FN_RE =
  /\bCREATE\s+(FUNCTION|PROCEDURE)\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?(\s+RETURNS\s+([A-Za-z]+))?/i;

function lineRange(line: number, length: number): Range {
  return Range.create(line, 0, line, length);
}

function nameRange(line: number, name: string, matchText: string): Range {
  const idx = matchText.indexOf(name);
  const start = idx >= 0 ? idx : 0;
  return Range.create(line, start, line, start + name.length);
}

/** A line span (module or routine) that can own nested symbols. */
interface BlockScope {
  startLine: number;
  endLine: number;
  symbol: DocumentSymbol;
}

/** Find the line that closes the BEGIN block opened at/after `fromLine`. */
function findBodyEndLine(lines: string[], fromLine: number): number {
  let depth = 0;
  let started = false;
  for (let j = fromLine; j < lines.length; j++) {
    const line = lines[j];
    if (findBeginToken(line) >= 0) {
      started = true;
      depth++;
    }
    if (findEndToken(line) >= 0) {
      if (started) {
        depth--;
        if (depth === 0) return j;
      }
    }
    // Stop if we hit another top-level declaration (malformed input guard).
    if (j > fromLine && (MODULE_RE.test(line) || END_MODULE_RE.test(line))) break;
  }
  return fromLine;
}

export function documentSymbols(source: string): DocumentSymbol[] {
  const { lines } = scan(source);
  const symbols: DocumentSymbol[] = [];
  const modules: BlockScope[] = [];
  const functions: BlockScope[] = [];

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
        selectionRange: nameRange(i, broker[1], broker[0]),
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
        selectionRange: nameRange(i, mod[2], mod[0]),
        children: [],
      };
      symbols.push(symbol);
      modules.push({ startLine: i, endLine: end, symbol });
      continue;
    }

    // ── FUNCTION / PROCEDURE ─────────────────────────────────────────────
    const fn = FN_RE.exec(line);
    if (fn) {
      const end = findBodyEndLine(lines, i);
      const params = fn[4] ? fn[4].trim() : '';
      const returns = fn[6] ? ` RETURNS ${fn[6].toUpperCase()}` : '';
      const symbol: DocumentSymbol = {
        name: fn[2],
        detail: `${fn[1].toUpperCase()}(${params})${returns}`,
        kind: SymbolKind.Function,
        range: Range.create(i, 0, end, lines[end].length),
        selectionRange: nameRange(i, fn[2], fn[0]),
        children: [],
      };
      const owner = modules.find((m) => i > m.startLine && i <= m.endLine);
      if (owner) owner.symbol.children!.push(symbol);
      else symbols.push(symbol);
      functions.push({ startLine: i, endLine: end, symbol });
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
    // Parameters sit on the header line itself, so the span starts there.
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
