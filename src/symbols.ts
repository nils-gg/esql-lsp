/**
 * ESQL document symbols (Phase 1).
 *
 * Extracted by pattern matching on masked lines (no parser yet — see
 * roadmap). Structure:
 *
 *   Namespace (BROKER SCHEMA)
 *   Module          CREATE COMPUTE|FILTER|DATABASE MODULE ... END MODULE
 *     Function      CREATE FUNCTION|PROCEDURE ... (body bounded by BEGIN/END)
 *     Variable      DECLARE name type
 */

import { DocumentSymbol, Range, SymbolKind } from 'vscode-languageserver';
import { scan, findBeginToken, findEndToken } from './scanner';

const BROKER_RE = /\bBROKER\s+SCHEMA\s+([A-Za-z0-9_.]+)/i;
const MODULE_RE = /\bCREATE\s+(COMPUTE|FILTER|DATABASE)\s+MODULE\s+([A-Za-z_]\w*)/i;
const END_MODULE_RE = /\bEND\s+MODULE\b/i;
const FN_RE = /\bCREATE\s+(FUNCTION|PROCEDURE)\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?/i;
const DECLARE_RE = /\bDECLARE\s+([A-Za-z_]\w*)\s+(?:CONSTANT\s+)?([A-Za-z]+)/i;

function lineRange(line: number, length: number): Range {
  return Range.create(line, 0, line, length);
}

function nameRange(line: number, name: string, matchText: string): Range {
  const idx = matchText.indexOf(name);
  const start = idx >= 0 ? idx : 0;
  return Range.create(line, start, line, start + name.length);
}

interface ModuleScope {
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
  const modules: ModuleScope[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── BROKER SCHEMA ────────────────────────────────────────────────────
    const broker = BROKER_RE.exec(line);
    if (broker) {
      symbols.push({
        name: broker[1],
        kind: SymbolKind.Namespace,
        range: lineRange(i, line.length),
        selectionRange: nameRange(i, broker[1], broker[0]),
      });
      continue;
    }

    // ── MODULE ───────────────────────────────────────────────────────────
    const mod = MODULE_RE.exec(line);
    if (mod) {
      let end = i;
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
      const symbol: DocumentSymbol = {
        name: fn[2],
        detail: `${fn[1].toUpperCase()}${params ? `(${params})` : '()'}`,
        kind: SymbolKind.Function,
        range: Range.create(i, 0, end, lines[end].length),
        selectionRange: nameRange(i, fn[2], fn[0]),
        children: [],
      };
      const owner = modules.find((m) => i > m.startLine && i <= m.endLine);
      if (owner) owner.symbol.children!.push(symbol);
      else symbols.push(symbol);
      continue;
    }

    // ── DECLARE ──────────────────────────────────────────────────────────
    const decl = DECLARE_RE.exec(line);
    if (decl) {
      const constant = /\bCONSTANT\b/i.test(line) ? 'CONSTANT ' : '';
      const symbol: DocumentSymbol = {
        name: decl[1],
        detail: `${constant}${decl[2].toUpperCase()}`,
        kind: SymbolKind.Variable,
        range: lineRange(i, line.length),
        selectionRange: nameRange(i, decl[1], decl[0]),
      };
      const owner = modules.find((m) => i > m.startLine && i <= m.endLine);
      if (owner) owner.symbol.children!.push(symbol);
      else symbols.push(symbol);
    }
  }

  return symbols;
}
