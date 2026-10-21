/**
 * ESQL static analysis (Phase 1).
 *
 * Ported from joaquinvulcano/esql-vscode (MIT, see ATTRIBUTION.md). The rule
 * ideas are the same; the implementations were rewritten on top of the
 * scanner (src/scanner.ts), so patterns never see comments or string
 * contents. This fixes the original's class of false positives (e.g. a `--`
 * or `END MODULE` inside a string literal).
 *
 * Checks (each independently toggleable via settings):
 *   1. Module structure      – missing `END MODULE` (error), missing Main() (warning)
 *   2. Undeclared variables  – `SET x = ...` without `DECLARE x` (warning)
 *   3. Main() propagation    – no RETURN / PROPAGATE in Main() (warning)
 *   4. Missing semicolon     – statement likely lacks `;` (hint)
 *   5. Deprecated XMLNS      – use XMLNSC in ACE 12 (warning)
 *   6. OutputRoot JSON       – JSON.Data set without Properties copy (hint)
 *
 * Check 1 emits two finding kinds (missing END MODULE, missing Main()), so
 * clients see seven distinct diagnostic findings in total.
 */

import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { scan, findBeginToken, findEndToken } from './scanner';
import { EsqlDiagnosticsSettings } from './settings';
import type { DocAnalysis } from './parser';

const MODULE_RE = /\bCREATE\s+(COMPUTE|FILTER|DATABASE)\s+MODULE\s+([A-Za-z_]\w*)/i;
const END_MODULE_RE = /\bEND\s+MODULE\b/i;
const MAIN_RE = /\bCREATE\s+FUNCTION\s+Main\s*\(\s*\)/i;
/** `DECLARE name[, name…] [CONSTANT|SHARED|EXTERNAL] type …` — group 1 is
 * the FULL comma-separated name list (a multi-name declaration declares
 * every name), group 2 the type word. Handler declarations
 * (`DECLARE CONTINUE|EXIT HANDLER …`) declare no variable and are excluded.
 * Shared with completion.ts so both agree on what is declared. */
export const DECLARE_RE =
  /\bDECLARE\s+(?!CONTINUE\b|EXIT\b)((?:[A-Za-z_]\w*\s*,\s*)*[A-Za-z_]\w*)\s+(?:CONSTANT\s+|SHARED\s+|EXTERNAL\s+)*([A-Za-z]+)/i;
const FN_PARAMS_RE = /\bCREATE\s+(?:FUNCTION|PROCEDURE)\s+[A-Za-z_]\w*\s*\(([^)]*)\)/i;
const FN_PARAM_RE = /\b(?:IN|OUT|INOUT)\s+([A-Za-z_]\w*)/i;
const SET_VAR_RE = /^\s*SET\s+([A-Za-z_]\w*)(?!\s*\.)\s*(?:=|:=)/i;
const XMLNS_RE = /\bXMLNS\b(?!C)/i;
const JSON_DATA_RE = /^\s*SET\s+OutputRoot\.JSON\.Data\b/i;
const PROPS_COPIED_RE = /SET\s+OutputRoot\.Properties\b/i;
const OUTPUT_ROOT_COPIED_RE = /SET\s+OutputRoot\s*(=|;)/i;

/**
 * Words after which a statement may legitimately continue on the next line
 * (used by the missing-semicolon heuristic).
 */
const CONTINUATION_END_RE =
  /\b(BEGIN|THEN|ELSE|ELSEIF|DO|EXCEPTION|TERMINAL|LABEL|MESSAGE|SEVERITY|CATALOG|VALUES|TO|FROM|WHERE|AS|BY|IN|LIKE|BETWEEN|WHEN|CASE)\s*$/i;
/** Trailing characters that indicate an expression continues. */
const CONTINUATION_CHAR_RE = /[=+\-*/<>|,(\[]\s*$/;
/** Statement starters that must end with `;`. */
const STATEMENT_START_RE =
  /^\s*(SET|DECLARE|PROPAGATE|THROW|CALL|DELETE|MOVE|DETACH|ATTACH|COPY|PASSTHRU)\s+/i;

/** Keywords that are never user variables (SET targets). */
const RESERVED_SET_TARGETS = new Set(
  [
    'TRUE', 'FALSE', 'NULL', 'UNKNOWN',
    'InputRoot', 'OutputRoot', 'InputLocalEnvironment', 'OutputLocalEnvironment',
    'LocalEnvironment', 'Environment', 'InputExceptionList', 'OutputExceptionList',
    'DestinationList', 'SQLSTATE', 'SQLCODE', 'SQLERRORTEXT', 'SQLNATIVEERROR',
    'IF', 'THEN', 'ELSE', 'ELSEIF', 'END', 'BEGIN', 'WHILE', 'DO', 'FOR',
    'RETURN', 'PROPAGATE', 'SET', 'DECLARE', 'CALL', 'THROW', 'LEAVE', 'ITERATE',
    'SELECT', 'FROM', 'WHERE', 'INTO', 'AS', 'ITEM', 'TO', 'OF', 'IN', 'OUT',
    'PASSTHRU', 'DATABASE', 'CASE', 'WHEN', 'LOOP', 'REPEAT', 'UNTIL',
    'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME',
    'AND', 'OR', 'NOT', 'LIKE', 'BETWEEN', 'EXISTS', 'IS',
    'CHARACTER', 'INTEGER', 'FLOAT', 'DECIMAL', 'BOOLEAN', 'BLOB',
    'DATE', 'TIME', 'TIMESTAMP', 'INTERVAL', 'ROW', 'REFERENCE', 'NAMESPACE',
    'CONSTANT', 'EXTERNAL', 'HANDLER', 'CONTINUE', 'EXIT', 'UNDO', 'ATOMIC',
    'FIRST', 'LAST', 'NEXT', 'PRIOR', 'PREVIOUS', 'FIRSTCHILD', 'LASTCHILD',
    'NEXTSIBLING', 'PREVIOUSSIBLING', 'PARENT', 'MOVE', 'DETACH', 'ATTACH', 'COPY',
    'DELETE', 'FIELD', 'USER', 'EXCEPTION', 'MESSAGE', 'SEVERITY', 'CATALOG', 'VALUES',
    'FUNCTION', 'PROCEDURE', 'RETURNS', 'MODULE', 'BROKER', 'SCHEMA', 'CREATE',
    'COMPUTE', 'FILTER', 'MAIN',
  ].map((w) => w.toUpperCase())
);

function lineRange(line: number, text: string, start = 0, end = text.length): Range {
  return Range.create(line, start, line, end);
}

/** Collect every DECLAREd name and function parameter (upper-cased). */
function collectDeclaredNames(lines: string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    const decl = DECLARE_RE.exec(line);
    if (decl) {
      for (const name of decl[1].split(',')) {
        names.add(name.trim().toUpperCase());
      }
    }

    const fn = FN_PARAMS_RE.exec(line);
    if (fn && fn[1]) {
      for (const param of fn[1].split(',')) {
        const p = FN_PARAM_RE.exec(param);
        if (p) names.add(p[1].toUpperCase());
      }
    }
  }
  return names;
}

/**
 * Run all enabled checks. When `doc` (a tree-sitter DocAnalysis) is given,
 * grammar-backed results replace the corresponding heuristics:
 *   - syntax errors come from ERROR/MISSING nodes (checkSyntaxErrors),
 *   - undeclared-variable detection uses the real declared-name set and the
 *     real bare-SET targets (multi-line aware, no regex false positives),
 *   - the missing-semicolon hint is skipped (a real missing `;` now
 *     produces a grammar syntax error instead).
 * Without `doc` (grammar unavailable) everything is the Phase 1 regex path.
 */
export function analyze(
  source: string,
  settings: EsqlDiagnosticsSettings,
  doc?: DocAnalysis
): Diagnostic[] {
  if (!settings.enabled) return [];
  const diagnostics: Diagnostic[] = [];
  const { lines } = scan(source);

  if (doc && settings.checkSyntaxErrors) {
    for (const issue of doc.syntaxIssues) {
      diagnostics.push(
        Diagnostic.create(issue.range, issue.message, DiagnosticSeverity.Error)
      );
    }
  }

  checkModuleStructure(lines, diagnostics);
  if (settings.checkUndeclaredVariables) {
    if (doc) checkDeclaredVariablesFromTree(doc, diagnostics);
    else checkDeclaredVariables(lines, diagnostics);
  }
  if (settings.checkPropagation) {
    checkPropagateOrReturn(lines, diagnostics);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (settings.checkDeprecatedParsers) checkDeprecatedParsers(i, line, diagnostics);
    // With the grammar there is an authoritative error for a real missing
    // `;` already — the hint would only add noise.
    if (settings.checkMissingSemicolon && !doc) checkMissingSemicolon(i, line, diagnostics);
    if (settings.checkOutputRootProperties) {
      checkOutputRootProperties(i, line, lines, diagnostics);
    }
  }

  return diagnostics;
}

/** 1. Module structure: missing END MODULE, missing Main(). */
function checkModuleStructure(lines: string[], out: Diagnostic[]): void {
  let moduleStart = -1;
  let moduleName = '';
  let hasMain = false;
  let moduleClosed = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const mod = MODULE_RE.exec(line);
    if (mod) {
      moduleStart = i;
      moduleName = mod[2];
      hasMain = false;
    }

    if (MAIN_RE.test(line)) hasMain = true;

    if (END_MODULE_RE.test(line)) {
      if (moduleStart >= 0 && !hasMain) {
        out.push(Diagnostic.create(
          lineRange(i, line),
          `Module '${moduleName}' contains no Main() function. ACE cannot execute it.`,
          DiagnosticSeverity.Warning
        ));
      }
      moduleClosed = i;
      moduleStart = -1;
      moduleName = '';
    }
  }

  if (moduleStart >= 0 && moduleClosed < moduleStart) {
    out.push(Diagnostic.create(
      lineRange(moduleStart, lines[moduleStart]),
      `Module '${moduleName || '<unnamed>'}' is missing its closing 'END MODULE'.`,
      DiagnosticSeverity.Error
    ));
  }
}

/** 2. Undeclared variables assigned via SET (heuristic, no grammar). */
function checkDeclaredVariables(lines: string[], out: Diagnostic[]): void {
  const declared = collectDeclaredNames(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = SET_VAR_RE.exec(line);
    if (!m) continue;

    const name = m[1];
    const upper = name.toUpperCase();
    if (RESERVED_SET_TARGETS.has(upper) || declared.has(upper)) continue;

    const col = line.indexOf(name, m.index);
    out.push(Diagnostic.create(
      lineRange(i, line, col, col + name.length),
      `Variable '${name}' is used in SET but never declared with DECLARE.`,
      DiagnosticSeverity.Warning
    ));
  }
}

/** 2. Undeclared variables via the parse tree (exact ranges, multi-line). */
function checkDeclaredVariablesFromTree(doc: DocAnalysis, out: Diagnostic[]): void {
  const declared = new Set(doc.declaredNames.map((d) => d.name.toUpperCase()));
  for (const target of doc.setTargets) {
    const upper = target.name.toUpperCase();
    if (RESERVED_SET_TARGETS.has(upper) || declared.has(upper)) continue;
    out.push(Diagnostic.create(
      target.range,
      `Variable '${target.name}' is used in SET but never declared with DECLARE.`,
      DiagnosticSeverity.Warning
    ));
  }
}

/** 3. Main() must contain RETURN or PROPAGATE. */
function checkPropagateOrReturn(lines: string[], out: Diagnostic[]): void {
  let inMain = false;
  let mainStart = -1;
  let depth = 0;
  let bodySeen = false;
  let hasReturnOrPropagate = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (MAIN_RE.test(line)) {
      inMain = true;
      mainStart = i;
      depth = 0;
      bodySeen = false;
      hasReturnOrPropagate = false;
    }

    if (!inMain) continue;

    if (findBeginToken(line) >= 0) {
      bodySeen = true;
      depth++;
    }

    if (findEndToken(line) >= 0) {
      depth--;
      if (depth <= 0 && bodySeen) {
        if (!hasReturnOrPropagate) {
          out.push(Diagnostic.create(
            lineRange(mainStart, lines[mainStart]),
            'Main() contains neither RETURN nor PROPAGATE. The message will not reach any terminal.',
            DiagnosticSeverity.Warning
          ));
        }
        inMain = false;
      }
    }

    if (/\bRETURN\b/i.test(line) || /\bPROPAGATE\b/i.test(line)) {
      hasReturnOrPropagate = true;
    }
  }

  // Main() declared but its BEGIN block was never closed.
  if (inMain && bodySeen) {
    out.push(Diagnostic.create(
      lineRange(mainStart, lines[mainStart]),
      'Main() body is not closed with END;.',
      DiagnosticSeverity.Warning
    ));
  }
}

/** 5. Deprecated XMLNS parser. */
function checkDeprecatedParsers(lineIdx: number, line: string, out: Diagnostic[]): void {
  const m = XMLNS_RE.exec(line);
  if (!m) return;
  out.push(Diagnostic.create(
    lineRange(lineIdx, line, m.index, m.index + 5),
    "Parser 'XMLNS' is deprecated. Use 'XMLNSC' in ACE 12.",
    DiagnosticSeverity.Warning
  ));
}

/** 4. Statement likely missing its terminating semicolon. */
function checkMissingSemicolon(lineIdx: number, line: string, out: Diagnostic[]): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (STATEMENT_START_RE.test(line)) {
    if (
      !trimmed.endsWith(';') &&
      !trimmed.endsWith(',') &&
      !CONTINUATION_END_RE.test(trimmed) &&
      !CONTINUATION_CHAR_RE.test(trimmed)
    ) {
      out.push(Diagnostic.create(
        lineRange(lineIdx, line, trimmed.length, line.length),
        "Possible missing semicolon (';') at end of statement.",
        DiagnosticSeverity.Hint
      ));
    }
  }
}

/** 6. Building OutputRoot.JSON.Data without copying Properties first. */
function checkOutputRootProperties(
  lineIdx: number,
  line: string,
  lines: string[],
  out: Diagnostic[]
): void {
  if (!JSON_DATA_RE.test(line)) return;

  const start = Math.max(0, lineIdx - 10);
  const prev = lines.slice(start, lineIdx).join('\n');
  if (PROPS_COPIED_RE.test(prev) || OUTPUT_ROOT_COPIED_RE.test(prev)) return;

  out.push(Diagnostic.create(
    lineRange(lineIdx, line),
    "Building OutputRoot.JSON.Data but no copy of Properties detected nearby. " +
      "Did you forget 'SET OutputRoot.Properties = InputRoot.Properties;'?",
    DiagnosticSeverity.Hint
  ));
}
