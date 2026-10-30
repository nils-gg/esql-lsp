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
 *   2b. Undeclared reads     – expression reads of never-declared names
 *                              (warning; fallback mode scans conservatively)
 *   3. Main() propagation    – no RETURN / PROPAGATE in Main() (warning)
 *   4. Missing semicolon     – statement likely lacks `;` (hint)
 *   5. Deprecated XMLNS      – use XMLNSC in ACE 12 (warning)
 *   6. Deprecated LOGICAL    – legacy datatype; prefer BOOLEAN (hint)
 *   7. OutputRoot JSON       – JSON.Data set without Properties copy (hint)
 *   8. Unknown routine       – `CALL`/call of no known routine (warning;
 *                              needs a workspace root — silent without one)
 *
 * Check 1 emits two finding kinds (missing END MODULE, missing Main()), and
 * check 2 and 3 one each on both paths plus check 1's grammar-mode syntax
 * error, so clients see the twelve codes of `DiagnosticCode` in total.
 */

import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { scan, findBeginToken, findEndToken } from './scanner';
import { EsqlDiagnosticsSettings } from './settings';
import { declarationsFromSource, bareTargetsFromSource, routinesFromSource, rangeContains, MODULE_RE, END_MODULE_RE } from './definitions';
import { ESQL_FUNCTIONS, ESQL_KEYWORDS } from './data/esqlData';
import { didYouMean } from './suggest';
import type { DocAnalysis } from './parser';

// The module-boundary matchers are imported from definitions.ts, not re-typed
// here: the local MODULE_RE copy this file used to carry omitted
// DATABASEEVENT, so both module checks were blind to that module kind, while
// declarations/hover/completion saw it (CODE_REVIEW.md E-6 + T-4).
const MAIN_RE = /\bCREATE\s+FUNCTION\s+Main\s*\(\s*\)/i;
/** Routine header, used to group per-routine hints (ISSUES.md I-7). */
const ROUTINE_RE = /\bCREATE\s+(?:FUNCTION|PROCEDURE)\b/i;
/** What the deprecated-parser check looks for: `XMLNS` used as a parser in a
 * path, i.e. followed by a dot. A namespace-declaration prefix is spelled
 * `xmlns:something` and is a NAME, not the parser (ISSUES.md I-8). */
const XMLNS_RE = /\bXMLNS\b(?!C)(?=[ \t]*\.)/i;
// Legacy truth-value datatype (CODE_REVIEW.md E-3). The datatype SLOT is
// pinned — name list then optional SHARED/EXTERNAL/CONSTANT (the railroad's
// order) then LOGICAL — so a variable literally named `logical`
// (`DECLARE logical INTEGER;`) cannot light up, and the line is masked, so
// `'LOGICAL'` inside a string stays silent. Best-effort by design: a DECLARE
// split across lines is missed, exactly like the other flat checks.
const DECLARE_LOGICAL_RE =
  /\bDECLARE\b\s+[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*(?:\s+(?:SHARED|EXTERNAL|CONSTANT))*\s+(LOGICAL)\b/i;
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
  doc?: DocAnalysis,
  /**
   * UPPERCASE names declared `SHARED` in other files of the workspace
   * (ISSUES.md I-13). A shared variable is visible to every flow of the ACE
   * application, and the LSP's workspace is the closest thing it has to an
   * application boundary — so these satisfy the undeclared check alongside
   * the file's own declarations. Absent (no workspace root, or a unit test
   * that wants file-local semantics) means exactly today's behavior.
   */
  workspaceSharedNames?: ReadonlySet<string>,
  /**
   * Routine names as written, declared anywhere in the workspace — live open
   * buffers included (task-4 index lookup; CODE_REVIEW.md E-4). The allow
   * list for the `unknown-routine` check. Absent (no workspace root, or the
   * index skipped files) keeps the check silent: without the workspace, a
   * CALL target outside this file is unverifiable, not wrong.
   */
  workspaceRoutineNames?: ReadonlySet<string>
): Diagnostic[] {
  if (!settings.enabled) return [];
  const diagnostics: Diagnostic[] = [];
  const { lines, rawLines } = scan(source);

  if (doc && settings.checkSyntaxErrors) {
    // E-7 (one diagnostic per root cause): an unclosed module makes the
    // grammar swallow its whole body — the named
    // `Syntax error in a module definition.` on the header line and
    // `missing-end-module` describe the SAME forgotten END MODULE, and the
    // structure check words it better (it knows the module's name). Where
    // both target the header of an unclosed module, the structure check
    // owns the line and the grammar's phrasing is dropped. Damaged module
    // headers that are NOT this shape keep their syntax message.
    const structure: Diagnostic[] = [];
    checkModuleStructure(lines, structure);
    const unclosedHeaders = new Set(
      structure
        .filter((d) => d.code === 'missing-end-module')
        .map((d) => d.range.start.line)
    );
    for (const issue of doc.syntaxIssues) {
      if (
        issue.kind === 'module-definition' &&
        unclosedHeaders.has(issue.range.start.line)
      )
        continue;
      diagnostics.push(
        diag(issue.range, issue.message, DiagnosticSeverity.Error, 'syntax-error')
      );
    }
    diagnostics.push(...structure);
  } else {
    checkModuleStructure(lines, diagnostics);
  }
  if (settings.checkUndeclaredVariables) {
    if (doc) checkDeclaredVariablesFromTree(doc, diagnostics, workspaceSharedNames);
    else checkDeclaredVariables(source, diagnostics, workspaceSharedNames);
  }
  if (settings.checkUndeclaredReads) {
    if (doc) checkUndeclaredReadsFromTree(source, doc, lines, diagnostics, workspaceSharedNames);
    else checkUndeclaredReadsFlat(source, lines, rawLines, diagnostics, workspaceSharedNames);
  }
  if (settings.checkPropagation) {
    checkPropagateOrReturn(lines, diagnostics);
  }
  if (settings.checkDeprecatedParsers) checkDeprecatedParsers(lines, diagnostics);
  if (settings.checkDeprecatedTypes) checkDeprecatedTypes(lines, diagnostics);
  // With the grammar there is an authoritative error for a real missing `;`
  // already — the hint would only add noise.
  if (settings.checkMissingSemicolon && !doc) checkMissingSemicolons(lines, diagnostics);
  if (settings.checkOutputRootProperties) checkOutputRootProperties(lines, diagnostics);
  if (settings.checkUnknownRoutines)
    checkUnknownRoutines(source, lines, doc, workspaceRoutineNames, diagnostics);

  return diagnostics;
}

/**
 * Stable identifiers for the checks below, carried on every diagnostic as
 * `code` (with `source: 'esql'`).
 *
 * Without them a client cannot tell an esql-lsp finding from another ESQL
 * extension's or a linter's, has nothing to group or colour by, and has no key
 * to suppress a single check with — the message text is not a stable key
 * (ISSUES.md I-21). They mirror the `diagnostics.check*` setting names, so the
 * settings table and the Problems pane agree.
 */
export type DiagnosticCode =
  | 'syntax-error'
  | 'module-no-main'
  | 'missing-end-module'
  | 'undeclared-variable'
  | 'undeclared-read'
  | 'no-propagation'
  | 'unclosed-main'
  | 'deprecated-parser'
  | 'deprecated-type'
  | 'unknown-routine'
  | 'missing-semicolon'
  | 'output-root-properties';

/** Every diagnostic this server publishes is built here. */
/**
 * Where the diagnostic codes are documented, sent as LSP `codeDescription.href`
 * on every diagnostic so a client can offer "explain this problem" without
 * matching message text. One anchor for the whole family: the README table
 * documents all eleven codes and mirrors the setting names; per-code anchors
 * would rot the moment the table is reworded.
 */
const DIAGNOSTIC_DOCS_HREF = 'https://github.com/nils-gg/esql-lsp#diagnostics';

function diag(
  range: Range,
  message: string,
  severity: DiagnosticSeverity,
  code: DiagnosticCode
): Diagnostic {
  const d = Diagnostic.create(range, message, severity, code, 'esql');
  d.codeDescription = { href: DIAGNOSTIC_DOCS_HREF };
  return d;
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
      // A header while a module is still open DISPLACES it: that module never
      // saw its END MODULE and, once overwritten, nothing below reports it —
      // the loop-end check can only ever see the LAST unclosed header
      // (correctness review 2026-10-30). Flush the displaced module now, with
      // the same two findings the END MODULE close gives a closing module.
      if (moduleStart >= 0) {
        out.push(diag(
          lineRange(moduleStart, lines[moduleStart]),
          `Module '${moduleName || '<unnamed>'}' is missing its closing 'END MODULE'.`,
          DiagnosticSeverity.Error,
          'missing-end-module'
        ));
        if (!hasMain) {
          out.push(diag(
            lineRange(i, line),
            `Module '${moduleName}' contains no Main() function. ACE cannot execute it.`,
            DiagnosticSeverity.Warning,
            'module-no-main'
          ));
        }
      }
      moduleStart = i;
      moduleName = mod[2];
      hasMain = false;
    }

    if (MAIN_RE.test(line)) hasMain = true;

    if (END_MODULE_RE.test(line)) {
      if (moduleStart >= 0 && !hasMain) {
        out.push(diag(
          lineRange(i, line),
          `Module '${moduleName}' contains no Main() function. ACE cannot execute it.`,
          DiagnosticSeverity.Warning,
          'module-no-main'
        ));
      }
      moduleClosed = i;
      moduleStart = -1;
      moduleName = '';
    }
  }

  if (moduleStart >= 0 && moduleClosed < moduleStart) {
    out.push(diag(
      lineRange(moduleStart, lines[moduleStart]),
      `Module '${moduleName || '<unnamed>'}' is missing its closing 'END MODULE'.`,
      DiagnosticSeverity.Error,
      'missing-end-module'
    ));
  }
}

/** 2. Undeclared variables assigned via SET (heuristic, no grammar). */
function checkDeclaredVariables(
  source: string,
  out: Diagnostic[],
  workspaceSharedNames?: ReadonlySet<string>
): void {
  const declared = collectDeclaredNames(source);
  if (workspaceSharedNames) for (const n of workspaceSharedNames) declared.add(n);

  for (const target of bareTargetsFromSource(source)) {
    const upper = target.name.toUpperCase();
    if (RESERVED_SET_TARGETS.has(upper) || declared.has(upper)) continue;

    out.push(diag(
      target.range,
      `Variable '${target.name}' is assigned here but never declared with DECLARE.`,
      DiagnosticSeverity.Warning,
      'undeclared-variable'
    ));
  }
}

/** 2. Undeclared variables via the parse tree (exact ranges, multi-line). */
function checkDeclaredVariablesFromTree(
  doc: DocAnalysis,
  out: Diagnostic[],
  workspaceSharedNames?: ReadonlySet<string>
): void {
  const declared = new Set(doc.declaredNames.map((d) => d.name.toUpperCase()));
  if (workspaceSharedNames) for (const n of workspaceSharedNames) declared.add(n);
  for (const target of doc.setTargets) {
    const upper = target.name.toUpperCase();
    if (RESERVED_SET_TARGETS.has(upper) || declared.has(upper)) continue;
    out.push(diag(
      target.range,
      `Variable '${target.name}' is assigned here but never declared with DECLARE.`,
      DiagnosticSeverity.Warning,
      'undeclared-variable'
    ));
  }
}

/**
 * 2b. Reads of never-declared variables (CODE_REVIEW.md E-5), tree path.
 * The tree hands over exactly the bare identifiers (`field_reference` with
 * one identifier — message-tree paths never appear); names inside a
 * `select_expression` are columns/tables/aliases, and a name sitting AT a
 * setTarget position is a WRITE that check 2 owns — otherwise
 * `SET nowhere = 1;` would be reported twice with contradicting roles.
 *
 * Declaredness is FILE-FLAT, not per scope, deliberately: a name declared
 * somewhere stays silent even where this position cannot see it — a scope
 * miss is a different (true) problem deserving its own message, while a
 * fabricated scope error is the E-2 failure mode reborn. File-flat ⊆
 * "nowhere in scope", and it is the notion both paths can agree on
 * (the E-3/E-2b discipline: the fallback is a sold mode, not a degraded one).
 */
/**
 * The UPPER → as-written name map the `undeclared-read` check answers from —
 * membership test AND did-you-mean candidates in one construction, checks
 * and quick fixes fed by ONE extractor (the E-6 discipline). The tree view
 * additionally vouches for namespace aliases it can see; the flat view
 * cannot tell one from a plain name and misses it — a missing candidate,
 * never a fabricated one.
 */
function readDeclaredSpellings(
  source: string,
  lines: string[],
  doc?: DocAnalysis,
  workspaceSharedNames?: ReadonlySet<string>
): Map<string, string> {
  const declared = new Map<string, string>(); // UPPER → as written (first wins)
  const put = (n: string): void => {
    const u = n.toUpperCase();
    if (!declared.has(u)) declared.set(u, n);
  };
  if (doc) {
    for (const d of doc.declaredNames) put(d.name);
    for (const d of doc.namespaceAliases) put(d.name);
  } else {
    for (const d of declarationsFromSource(source)) put(d.name);
  }
  for (const n of forBoundNames(lines)) put(n);
  if (workspaceSharedNames) for (const n of workspaceSharedNames) put(n);
  return declared;
}

/**
 * The `undeclared-read` did-you-mean candidate list, as written — the exact
 * list the check suggests from, exported so the quick fix's replace-actions
 * agree with the published message in both modes (E-9).
 */
export function readCandidateNames(
  source: string,
  doc?: DocAnalysis,
  workspaceSharedNames?: ReadonlySet<string>
): string[] {
  return [...readDeclaredSpellings(source, scan(source).lines, doc, workspaceSharedNames).values()];
}

function checkUndeclaredReadsFromTree(
  source: string,
  doc: DocAnalysis,
  lines: string[],
  out: Diagnostic[],
  workspaceSharedNames?: ReadonlySet<string>
): void {
  const declared = readDeclaredSpellings(source, lines, doc, workspaceSharedNames);
  const writtenAt = new Set(
    doc.setTargets.map((t) => `${t.name.toUpperCase()}@${t.range.start.line}:${t.range.start.character}`)
  );
  for (const ref of doc.references) {
    if (ref.kind !== 'variable') continue;
    const upper = ref.name.toUpperCase();
    // An official keyword/datatype/built-in word is never a NAME to vouch
    // for — the pages say do not use them as variable names, and a bare
    // identifier shaped like one is error recovery's artifact (`DAYS` left
    // over from `INTERVAL '1' DAYS` after the qualifier rule's repair), not
    // a read of something the user wrote.
    if (BUILTIN_CALL_WORDS.has(upper)) continue;
    if (RESERVED_SET_TARGETS.has(upper) || declared.has(upper)) continue;
    if (writtenAt.has(`${upper}@${ref.range.start.line}:${ref.range.start.character}`)) continue;
    // Inside an ERROR region the parse invented the tree — references there
    // are recovery artifacts (`SET a = Fn(` mid-typing flags 'Fn'). The
    // syntax error already owns that line.
    if (doc.errorRegions.some((r) => rangeContains(r, ref.range.start.line, ref.range.start.character)))
      continue;
    if (doc.selectExpressions.some((s) => rangeContains(s, ref.range.start.line, ref.range.start.character)))
      continue;
    // `Name(` is a CALL shape: `SET a = Fn(` mid-typing repairs to a
    // variable read of 'Fn' with the `(` in an ERROR tail — but Fn may be a
    // routine (E-4's territory) or a half-typed call. Never an E-5 read.
    if ((lines[ref.range.start.line] ?? '').slice(ref.range.end.character).trimStart().startsWith('('))
      continue;
    const suggestion = didYouMean(ref.name, [...declared.values()]);
    out.push(diag(
      ref.range,
      `Variable '${ref.name}' is read here but never declared.` +
        (suggestion.length ? ` Did you mean '${suggestion[0]}'?` : ''),
      DiagnosticSeverity.Warning,
      'undeclared-read'
    ));
  }
}

/**
 * 2b (fallback half). The flat scan has no tree to hide behind, so it is
 * deliberately narrower than the grammar path — a SUBSET of its findings,
 * never a contradiction: bare words at paren/brace depth 0 only (clause
 * words and subquery innards hide at depth > 0 by construction), no
 * CREATE/DECLARE header lines, no DB-expression lines, no word touching a
 * `.`/`(`/`[`/`:` (paths, calls, labels). FILES THE SCANNER FINDS DAMAGED —
 * unbalanced parens/braces once strings and comments are masked — skip the
 * check entirely: mid-typing, every depth judgement is unreliable, and a
 * false "never declared" on the line the user is writing is the worst
 * diagnostic this server can ship.
 */
function checkUndeclaredReadsFlat(
  source: string,
  lines: string[],
  rawLines: string[],
  out: Diagnostic[],
  workspaceSharedNames?: ReadonlySet<string>
): void {
  const declared = readDeclaredSpellings(source, lines, undefined, workspaceSharedNames);

  let round = 0;
  let curly = 0;
  for (const line of lines) {
    for (const ch of line) {
      if (ch === '(') round++;
      else if (ch === ')') round--;
      else if (ch === '{') curly++;
      else if (ch === '}') curly--;
      if (round < 0 || curly < 0) return; // closes something never opened
    }
  }
  if (round !== 0 || curly !== 0) return;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Adjacency reads the RAW line: masking blanks quotes, and offsets are
    // preserved in place, so only the unmasked view can see `X'…` glue.
    const raw = rawLines[i] ?? '';
    if (/^\s*(CREATE|DECLARE)\b/i.test(line)) continue; // headers + declaration slots
    if (/\b(SELECT|FROM|JOIN|WHERE)\b/i.test(line)) continue; // DB words: columns, tables, aliases
    let depth = 0;
    let prev = '';
    READ_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = READ_TOKEN_RE.exec(line))) {
      const tok = m[0];
      if (tok === '(' || tok === '{' || tok === '[') {
        depth++;
        prev = tok;
        continue;
      }
      if (tok === ')' || tok === '}' || tok === ']') {
        depth--;
        prev = tok;
        continue;
      }
      const upper = tok.toUpperCase();
      // Character adjacency, the flat view's only syntax: a word glued to a
      // digit is part of a numeric literal (`1e10`, `0x1F`), glued to `'` a
      // bit/string literal prefix (`X'FF00'`), glued to `)`/`]`/`:` the tail
      // of a tree path (`Data.(.Attribute)Title`, `Data.*:Name2`), glued to
      // `.` a field-path part. All are misses-by-design, never false flags.
      const pc = m.index > 0 ? raw[m.index - 1] : '';
      const next = raw.slice(m.index + tok.length).match(/^\s*(.)/)?.[1] ?? '';
      const skip =
        depth > 0 ||
        pc === '.' ||
        pc === ':' ||
        pc === ')' ||
        pc === ']' ||
        /\d/.test(pc) ||
        next === '.' ||
        next === '(' ||
        next === '[' ||
        next === "'" ||
        next === ':' ||
        READ_AFTER_SKIP.has(prev) ||
        READ_SKIP_WORDS.has(upper) ||
        declared.has(upper);
      if (!skip) {
        const suggestion = didYouMean(tok, [...declared.values()]);
        out.push(diag(
          lineRange(i, line, m.index, m.index + tok.length),
          `Variable '${tok}' is read here but never declared.` +
            (suggestion.length ? ` Did you mean '${suggestion[0]}'?` : ''),
          DiagnosticSeverity.Warning,
          'undeclared-read'
        ));
      }
      prev = upper;
    }
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

    // The RETURN/PROPAGATE flag is set BEFORE the END-close is evaluated:
    // `RETURN TRUE; END;` — header, body and close on one line, or just the
    // closing pair — is exactly the line that closes Main, and testing the
    // flag first flagged legal code with “Main() contains neither RETURN nor
    // PROPAGATE” (correctness review 2026-10-30; codeActions.ts treats the
    // `… ; END;` shape as real).
    if (/\bRETURN\b/i.test(line) || /\bPROPAGATE\b/i.test(line)) {
      hasReturnOrPropagate = true;
    }

    if (findEndToken(line) >= 0) {
      depth--;
      if (depth <= 0 && bodySeen) {
        if (!hasReturnOrPropagate) {
          out.push(diag(
            lineRange(mainStart, lines[mainStart]),
            'Main() contains neither RETURN nor PROPAGATE. The message will not reach any terminal.',
            DiagnosticSeverity.Warning,
            'no-propagation'
          ));
        }
        inMain = false;
      }
    }
  }

  // Main() declared but its BEGIN block was never closed.
  if (inMain && bodySeen) {
    out.push(diag(
      lineRange(mainStart, lines[mainStart]),
      'Main() body is not closed with END;.',
      DiagnosticSeverity.Warning,
      'unclosed-main'
    ));
  }
}

// E-4: the flat call scan sees every `WORD(` — these words may legitimately
// appear before `(` without being ESQL_KEYWORDS or documented functions:
// datatype words in CAST/precision clauses (`CAST(s AS VARCHAR(20))`,
// `DECIMAL(10,2)`, `CHARACTER VARYING(5)`). Flagging them is the flat scan's
// main false-positive risk.
const DATATYPE_SLOT_WORDS = [
  'INT', 'VARCHAR', 'CHAR', 'NUMERIC', 'DEC', 'VARYING', 'UNSIGNED',
  'NAMEVALUE', 'GMTTIME', 'GMTTIMESTAMP', 'LOGICAL', 'LIST',
];
/** Never an unknown-routine finding: documented ESQL functions (CAST and the
 * clause forms included), every ESQL keyword (`IF (`, `IN (SELECT`, …) and
 * the datatype words above. */
const BUILTIN_CALL_WORDS = new Set<string>([
  ...ESQL_FUNCTIONS.map((f) => f.name.toUpperCase()),
  ...ESQL_KEYWORDS.map((k) => k.toUpperCase()),
  ...DATATYPE_SLOT_WORDS,
]);
const CALL_RE = /\bCALL\s+([A-Za-z_]\w*)\b/gi;
const FUNC_CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;

/**
 * E-5's flat read scan, depth-0 FP classes — words that sit OUTSIDE
 * parens/braces (the depth rule already hides clause words like CCSID/FORMAT
 * inside them) yet are never variable reads:
 *  - INTERVAL qualifiers trailing their string literal (`+ INTERVAL '1' DAYS`);
 *  - the LOG statement's bare trace words (`LOG USER TRACE TEXT …`);
 *  - everything reserved, keyword, built-in or datatype (`RESERVED_SET_TARGETS`
 *    ∪ the E-4 allow list).
 * Words after SET/CALL/INTO/LEAVE/ITERATE/END are write targets, call names
 * and labels — handled positionally (`READ_AFTER_SKIP`), not as words.
 */
const READ_SKIP_WORDS = new Set<string>([
  ...RESERVED_SET_TARGETS,
  ...BUILTIN_CALL_WORDS,
  'DAY', 'DAYS', 'MONTH', 'MONTHS', 'HOUR', 'HOURS', 'MINUTE', 'MINUTES',
  'SECOND', 'SECONDS', 'YEAR', 'YEARS',
  'LOG', 'USER', 'TRACE', 'EVENT', 'TEXT',
]);
/** After these words the next bare word is a target, call name or label.
 * WHILE/REPEAT/FOR cover the label slot of `END WHILE L1;` and the binding
 * slot of `FOR i AS ...` — flat misses a read in an unparenthesised
 * `WHILE x > 0` condition because of it, the accepted subset trade. */
const READ_AFTER_SKIP = new Set(['SET', 'CALL', 'INTO', 'LEAVE', 'ITERATE', 'END', 'WHILE', 'REPEAT', 'FOR', 'SCHEMA']);

/**
 * Names a `FOR name AS ...` loop implicitly declares (a row-variable that
 * owns the iteration). Flat-extracted from the masked lines and shared by
 * BOTH E-5 paths — the tree marks the header slot but nothing downstream,
 * so without this the loop body's reads of the loop name are false flags.
 * A header split across lines is missed, like every flat extraction.
 */
function forBoundNames(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*FOR\s+([A-Za-z_]\w*)\b/i.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}
const READ_TOKEN_RE = /[A-Za-z_]\w*|[(){}\[\]]/g;

/** 5. Deprecated XMLNS parser, one finding per line. */
function checkDeprecatedParsers(lines: string[], out: Diagnostic[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = XMLNS_RE.exec(line);
    if (!m) continue;
    out.push(diag(
      lineRange(i, line, m.index, m.index + 'XMLNS'.length),
      "Parser 'XMLNS' is deprecated. Use 'XMLNSC' in ACE 12.",
      DiagnosticSeverity.Warning,
      'deprecated-parser'
    ));
  }
}

/**
 * 6. Legacy `LOGICAL` data type (CODE_REVIEW.md E-3). The grammar ACCEPTS it
 * (permissive superset — pre-ACE ESQL that ACE 12 still compiles, though the
 * 12.0.x DECLARE/keyword pages no longer list it; see VERIFICATION.md), so
 * the strictness lives here as the docs-grounded preference. Line-based and
 * therefore identical in both modes — the E-3 defect was precisely the two
 * paths disagreeing.
 */
function checkDeprecatedTypes(lines: string[], out: Diagnostic[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = DECLARE_LOGICAL_RE.exec(line);
    if (!m) continue;
    // The slot match can also hold a NAME spelled `logical`; the datatype
    // is the LAST LOGICAL inside the match.
    const col = m.index + m[0].toUpperCase().lastIndexOf('LOGICAL');
    out.push(diag(
      lineRange(i, line, col, col + 'LOGICAL'.length),
      "Data type 'LOGICAL' is legacy ESQL and deprecated. Use 'BOOLEAN' in ACE 12.",
      DiagnosticSeverity.Hint,
      'deprecated-type'
    ));
  }
}

/**
 * The `unknown-routine` did-you-mean candidate list: routines first (didYouMean
 * keeps candidate order on distance ties, and a sibling routine is what the
 * reader usually meant), built-ins behind them, keywords never. Empty without
 * a workspace routine set — exactly when the check itself is silent, so a
 * quick fix can never offer a replacement the check would not have suggested
 * (E-9; check and fix agree BY CONSTRUCTION, one extractor).
 */
export function routineCandidateNames(
  source: string,
  doc?: DocAnalysis,
  workspaceRoutineNames?: ReadonlySet<string>
): string[] {
  if (!workspaceRoutineNames) return [];
  const fileRoutines = (doc ? doc.routines : routinesFromSource(source)).map((r) => r.name);
  // Dedupe CASE-INSENSITIVELY, first spelling winning (correctness review
  // 2026-10-30): ESQL names fold case, didYouMean folds case, and the server
  // passes these sets as-written — so `Helper` here plus `HELPER` from a
  // sibling file is ONE routine that a case-sensitive Set listed twice. The
  // duplicate quickened no message (only [0] prints), but codeActions builds
  // one replace-action per candidate and shipped two rename actions for one
  // symbol, and on a distance tie the message could name the sibling's
  // spelling over the file's own.
  const seen = new Set<string>();
  const routines: string[] = [];
  for (const n of [...fileRoutines, ...workspaceRoutineNames]) {
    const upper = n.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    routines.push(n);
  }
  return [...routines, ...ESQL_FUNCTIONS.map((f) => f.name)];
}

/**
 * 8. Unknown routine (CODE_REVIEW.md E-4): a `CALL` target or expression call
 * that is neither declared in the file, nor in the workspace, nor a built-in
 * is a typo that otherwise only surfaces at deploy time.
 *
 * False-positive guards (the review's list, each named):
 *  - Runs only with a workspace routine set (`workspaceRoutineNames`): no
 *    workspace root → the workspace says nothing → silent, I-13 discipline.
 *    The server also silences the check when the index SKIPPED files — a
 *    routine may hide in one, silence beats a false flag.
 *  - Qualified targets: `CALL Schema.R(...)` lives outside anything the file
 *    set can verify — a name or qualified text containing `.` is skipped.
 *    (Expression-level dotted calls are rejected by the grammar outright, and
 *    the heuristic scan skips names preceded by `.`.)
 *  - `EXTERNAL NAME` routines: the form requires a local CREATE header, which
 *    both extractors index — the call hits the file allow list.
 *  - Built-ins / keywords / datatype words: `BUILTIN_CALL_WORDS`.
 *  - Qualified name parts of `Eval(`/`Route(` method-style paths never match
 *    (the preceding `.` disqualifies them).
 */
function checkUnknownRoutines(
  source: string,
  lines: string[],
  doc: DocAnalysis | undefined,
  workspaceRoutineNames: ReadonlySet<string> | undefined,
  out: Diagnostic[]
): void {
  if (!workspaceRoutineNames) return;
  const fileRoutines = (doc ? doc.routines : routinesFromSource(source)).map((r) => r.name);
  const known = new Set<string>(BUILTIN_CALL_WORDS);
  for (const n of fileRoutines) known.add(n.toUpperCase());
  for (const n of workspaceRoutineNames) known.add(n.toUpperCase());
  const candidates = routineCandidateNames(source, doc, workspaceRoutineNames);
  const seen = new Set<string>();
  const flag = (name: string, range: Range): void => {
    const key = `${name.toUpperCase()}@${range.start.line}:${range.start.character}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (known.has(name.toUpperCase())) return;
    const suggestion = didYouMean(name, candidates);
    out.push(diag(
      range,
      `Routine '${name}' is not defined in this file or workspace.` +
        (suggestion.length ? ` Did you mean '${suggestion[0]}'?` : ''),
      DiagnosticSeverity.Warning,
      'unknown-routine'
    ));
  };

  if (doc) {
    // Grammar path: every routine-shaped reference, CALL and expression
    // calls alike. Damage below a region can make a reference MISS (a missed
    // check, never a false flag) — accepted: the tree is authoritative.
    for (const ref of doc.references) {
      if (ref.kind !== 'routine') continue;
      if (ref.name.includes('.') || (ref.qualified ?? '').includes('.')) continue;
      flag(ref.name, ref.range);
    }
    return;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(CALL_RE)) {
      if (line.slice(m.index + m[0].length).startsWith('.')) continue; // qualified
      const col = m.index + m[0].lastIndexOf(m[1]);
      flag(m[1], lineRange(i, line, col, col + m[1].length));
    }
    for (const m of line.matchAll(FUNC_CALL_RE)) {
      if (line.slice(0, m.index).trimEnd().endsWith('.')) continue; // path part
      flag(m[1], lineRange(i, line, m.index, m.index + m[1].length));
    }
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

    out.push(diag(
      lineRange(i, line, line.length - trimmed.length, line.length),
      "Possible missing semicolon (';') at end of statement.",
      DiagnosticSeverity.Hint,
      'missing-semicolon'
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
export function hintScopes(lines: string[]): Array<{ start: number; end: number }> {
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
    out.push(diag(
      lineRange(offender, line),
      "Building OutputRoot.JSON.Data but no copy of Properties detected in this " +
        "routine. Did you forget 'SET OutputRoot.Properties = InputRoot.Properties;'?",
      DiagnosticSeverity.Hint,
      'output-root-properties'
    ));
  }
}
