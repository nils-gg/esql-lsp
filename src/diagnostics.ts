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
import { declarationsFromSource } from './definitions';
import type { DocAnalysis } from './parser';

const MODULE_RE = /\bCREATE\s+(COMPUTE|FILTER|DATABASE)\s+MODULE\s+([A-Za-z_]\w*)/i;
const END_MODULE_RE = /\bEND\s+MODULE\b/i;
const MAIN_RE = /\bCREATE\s+FUNCTION\s+Main\s*\(\s*\)/i;
/** Routine header, used to group per-routine hints (ISSUES.md I-7). */
const ROUTINE_RE = /\bCREATE\s+(?:FUNCTION|PROCEDURE)\b/i;
/** What the deprecated-parser check looks for: `XMLNS` used as a parser in a
 * path, i.e. followed by a dot. A namespace-declaration prefix is spelled
 * `xmlns:something` and is a NAME, not the parser (ISSUES.md I-8). */
const XMLNS_RE = /\bXMLNS\b(?!C)(?=[ \t]*\.)/i;
const SET_VAR_RE = /^\s*SET\s+([A-Za-z_]\w*)(?!\s*\.)\s*(?:=|:=)/i;
const JSON_DATA_RE = /^\s*SET\s+OutputRoot\.JSON\.Data\b/i;
const PROPS_MENTIONED_RE = /\bProperties\b/i;
const PROPS_COPIED_RE = /SET\s+OutputRoot\.Properties\b/i;
const OUTPUT_ROOT_COPIED_RE = /SET\s+OutputRoot\s*(=|;)/i;

/**
 * Words after which a statement may legitimately continue on the next line
 * (used by the missing-semicolon heuristic).
 */
const CONTINUATION_END_RE =
  /\b(BEGIN|THEN|ELSE|ELSEIF|DO|EXCEPTION|TERMINAL|LABEL|MESSAGE|SEVERITY|CATALOG|VALUES|TO|FROM|WHERE|AS|BY|IN|LIKE|BETWEEN|WHEN|CASE|SELECT)\s*$/i;
/** Trailing characters that indicate an expression continues. */
const CONTINUATION_CHAR_RE = /[=+\-*/<>|,(\[]\s*$/;
/**
 * Leading characters/words that can only CONTINUE an expression: the previous
 * line has no `;` because the statement carries on there, e.g. Healthcare's
 * `SET ibmHCAttempt = … as CHARACTER)` / next line `|| ' OF ' || CAST(…);`.
 */
const CONTINUATION_START_RE =
  /^\s*(\|\||\|\s|&&|[+*/%]|=(?!=)|-(?!-)|<>|<|>|,\s|(AND|OR|NOT|LIKE|BETWEEN|IS)\b)/i;
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

/**
 * Every DECLAREd name and routine parameter, upper-cased. This reads the same
 * extractor the outline, hover and definition use, so the undeclared-variable
 * check can never disagree with them about what is declared — a parameter list
 * spanning several lines used to be invisible here while the outline showed it.
 */
function collectDeclaredNames(source: string): Set<string> {
  return new Set(declarationsFromSource(source).map((d) => d.name.toUpperCase()));
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
    else checkDeclaredVariables(source, lines, diagnostics);
  }
  if (settings.checkPropagation) {
    checkPropagateOrReturn(lines, diagnostics);
  }
  if (settings.checkDeprecatedParsers) checkDeprecatedParsers(lines, diagnostics);
  // With the grammar there is an authoritative error for a real missing `;`
  // already — the hint would only add noise.
  if (settings.checkMissingSemicolon && !doc) checkMissingSemicolons(lines, diagnostics);
  if (settings.checkOutputRootProperties) checkOutputRootProperties(lines, diagnostics);

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
function checkDeclaredVariables(source: string, lines: string[], out: Diagnostic[]): void {
  const declared = collectDeclaredNames(source);

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

/** 5. Deprecated XMLNS parser, one finding per line. */
function checkDeprecatedParsers(lines: string[], out: Diagnostic[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = XMLNS_RE.exec(line);
    if (!m) continue;
    out.push(Diagnostic.create(
      lineRange(i, line, m.index, m.index + 'XMLNS'.length),
      "Parser 'XMLNS' is deprecated. Use 'XMLNSC' in ACE 12.",
      DiagnosticSeverity.Warning
    ));
  }
}

/**
 * 4. Statement likely missing its terminating semicolon.
 *
 * Whole-file, not per-line: `(` depth is tracked across lines so a continuation
 * inside a multi-line call (`SET x = CAST(FUN(InputRoot.BLOB.BLOB) …`,
 * `DECLARE bs BLOB ASBITSTREAM(InputRoot.MRM …`) is never mistaken for a
 * statement that forgot its `;` (ISSUES.md I-9). The hint also covers the
 * statement text rather than the whitespace tail of the line.
 */
function checkMissingSemicolons(lines: string[], out: Diagnostic[]): void {
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const depthAtStart = depth;
    depth += parenDelta(line);

    // Not a statement start, or still inside an unclosed `(`/`[`: whatever the
    // line ends with, the statement carries on.
    if (!trimmed || !STATEMENT_START_RE.test(line)) continue;
    if (
      depthAtStart !== 0 ||
      depth !== 0 ||
      trimmed.endsWith(';') ||
      trimmed.endsWith(',') ||
      CONTINUATION_END_RE.test(trimmed) ||
      CONTINUATION_CHAR_RE.test(trimmed)
    ) {
      continue;
    }

    // …and it can also carry on BELOW, with the operator written at the start of
    // the next line (`SET a = CAST(x as CHARACTER)` / `|| ' OF ' || CAST(y …);`).
    let next = i + 1;
    while (next < lines.length && !lines[next].trim()) next++;
    if (next < lines.length && CONTINUATION_START_RE.test(lines[next])) continue;

    out.push(Diagnostic.create(
      lineRange(i, line, line.length - trimmed.length, line.length),
      "Possible missing semicolon (';') at end of statement.",
      DiagnosticSeverity.Hint
    ));
  }
}

/** Net `(` / `[` openings on one masked line (strings are blanked, so safe). */
function parenDelta(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === '(' || ch === '[') delta++;
    else if (ch === ')' || ch === ']') delta--;
  }
  return delta;
}

/**
 * Scopes for per-scope hints: each routine header owns the lines up to the next
 * header or its module's `END MODULE`, and the text before the first header (or
 * the whole file when there is none) is one file-level scope. Every line lands
 * in exactly one scope.
 */
function hintScopes(lines: string[]): Array<{ start: number; end: number }> {
  const headers: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ROUTINE_RE.test(lines[i])) headers.push(i);
  }
  const scopes: Array<{ start: number; end: number }> = [];
  const last = lines.length - 1;
  if (last < 0) return scopes;
  if (!headers.length || headers[0] > 0) {
    scopes.push({ start: 0, end: (headers[0] ?? last) - 1 });
  }
  headers.forEach((start, k) => {
    let end = k + 1 < headers.length ? headers[k + 1] - 1 : last;
    for (let j = start; j <= end; j++) {
      if (END_MODULE_RE.test(lines[j])) {
        end = j - 1;
        break;
      }
    }
    if (start <= end) scopes.push({ start, end });
  });
  return scopes;
}

/**
 * 6. Building OutputRoot.JSON.Data without copying Properties.
 *
 * AT MOST ONE hint per routine, at the first offending `SET`, and none at all
 * when the scope never mentions `Properties`: a request-building node (HTTP/MQ
 * reply) legitimately assembles a JSON body with no properties to copy, and the
 * old per-line version produced 18 identical hints in one real file
 * (ISSUES.md I-7).
 */
function checkOutputRootProperties(lines: string[], out: Diagnostic[]): void {
  for (const scope of hintScopes(lines)) {
    const body = lines.slice(scope.start, scope.end + 1).join('\n');
    if (!PROPS_MENTIONED_RE.test(body)) continue;

    let offender = -1;
    for (let i = scope.start; i <= scope.end; i++) {
      if (JSON_DATA_RE.test(lines[i])) {
        offender = i;
        break;
      }
    }
    if (offender < 0) continue;

    if (PROPS_COPIED_RE.test(body) || OUTPUT_ROOT_COPIED_RE.test(body)) continue;

    const line = lines[offender];
    out.push(Diagnostic.create(
      lineRange(offender, line),
      "Building OutputRoot.JSON.Data but no copy of Properties detected in this " +
        "routine. Did you forget 'SET OutputRoot.Properties = InputRoot.Properties;'?",
      DiagnosticSeverity.Hint
    ));
  }
}
