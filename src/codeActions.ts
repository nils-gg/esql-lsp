/**
 * Quick fixes (CODE_REVIEW.md E-9, PLAN task 17).
 *
 * One pure function maps the diagnostics a client holds (echoed back in
 * `textDocument/codeAction`'s context) to `quickfix` CodeActions. Everything
 * is recomputed from the CURRENT document text rather than trusted from the
 * echoed diagnostic: a client may send findings published against an older
 * version, and a fix anchored in stale text edits the wrong characters. The
 * echo contributes only its `code` (which fix), its `range` (where) and its
 * message (the semicolon family is identified by the message naming `';'`).
 *
 * Placement contract for the inserting fixes: `DECLARE` and the Properties
 * copy go at the ROUTINE HEAD (ACE wants declarations before the routine's
 * statements), found flat via `hintScopes` + the scanner's BEGIN/END tokens —
 * identical in both modes, because both inputs are pattern-level; where a
 * flat placement cannot be justified (no enclosing routine, a one-line body
 * for a DECLARE), the DECLARE skeleton degrades to "above the flagged line"
 * — a skeleton the user reviews in the edit preview, never a silent guess.
 *
 * Every fix obeys the toggle of the check that owns its code (PLAN: "fixes
 * obey the owning check's toggle"), so a settings-off check cannot keep
 * handing out fixes through a client's stale echo. `module-no-main` and
 * `unclosed-main` get no fix deliberately: what they describe is a missing
 * routine and a missing `END` that no skeleton can honestly write for the
 * user. Other clients' diagnostics (source ≠ 'esql') are ignored.
 */
import { CodeAction, CodeActionKind, Diagnostic, Range, TextEdit } from 'vscode-languageserver';
import { scan, findBeginToken, findEndToken } from './scanner';
import { EsqlDiagnosticsSettings } from './settings';
import { didYouMean } from './suggest';
import {
  DiagnosticCode,
  hintScopes,
  readCandidateNames,
  routineCandidateNames,
} from './diagnostics';
import type { DocAnalysis } from './parser';

/** Workspace facts the candidate lists need — the same sets the checks ran
 * with at publish time (server assembles; this module stays a pure function
 * of its inputs, which is what makes the unit tests direct). */
export interface CodeActionFacts {
  analysis?: DocAnalysis;
  workspaceSharedNames?: ReadonlySet<string>;
  workspaceRoutineNames?: ReadonlySet<string>;
}

/** Which setting gates each fixable code. Codes absent here have no fix at
 * all (`module-no-main`, `unclosed-main`); `missing-end-module` is gated by
 * `enabled` alone, because the module-structure check itself is not
 * individually switchable. */
const FIX_TOGGLE: Partial<Record<DiagnosticCode, keyof EsqlDiagnosticsSettings>> = {
  'syntax-error': 'checkSyntaxErrors',
  'undeclared-variable': 'checkUndeclaredVariables',
  'undeclared-read': 'checkUndeclaredReads',
  'no-propagation': 'checkPropagation',
  'deprecated-parser': 'checkDeprecatedParsers',
  'deprecated-type': 'checkDeprecatedTypes',
  'unknown-routine': 'checkUnknownRoutines',
  'missing-semicolon': 'checkMissingSemicolon',
  'output-root-properties': 'checkOutputRootProperties',
};

/** `did-you-mean` actions per diagnostic — the message names one top hit,
 * the action list offers up to three (PLAN task 17). */
const MAX_CANDIDATE_ACTIONS = 3;

export function buildCodeActions(
  uri: string,
  text: string,
  contextDiagnostics: Diagnostic[],
  settings: EsqlDiagnosticsSettings,
  facts: CodeActionFacts
): CodeAction[] {
  if (!settings.enabled || contextDiagnostics.length === 0) return [];
  const { lines, rawLines } = scan(text);
  const out: CodeAction[] = [];
  for (const d of contextDiagnostics) {
    if (d.source !== 'esql') continue;
    const code = (typeof d.code === 'string' ? d.code : undefined) as DiagnosticCode | undefined;
    if (!code) continue;
    if (code !== 'missing-end-module') {
      const toggle = FIX_TOGGLE[code];
      if (!toggle || settings[toggle] === false) continue;
    }

    // Plain literals: the pinned protocol typings are pure interfaces here
    // (no TextEdit/CodeAction namespaces — same vintage as task 16's cast).
    const edit = (range: Range, newText: string): TextEdit => ({ range, newText });
    const at = (line: number, character: number): Range => Range.create(line, character, line, character);
    const single = (range: Range, newText: string) => ({ changes: { [uri]: [edit(range, newText)] } });

    switch (code) {
      case 'deprecated-parser':
        // The range IS the `XMLNS` word (the check put it there); replacing
        // it in place cannot touch a name that merely contains XMLNS.
        push(out, 'Use \'XMLNSC\' instead of \'XMLNS\'', single(d.range, 'XMLNSC'), d);
        break;
      case 'deprecated-type':
        // Same shape: the range is the exact `LOGICAL` datatype slot. The
        // PLAN fix list omitted this code, but it is the identical
        // message-implies-edit class as `deprecated-parser` ("Use 'BOOLEAN'")
        // and omitting it would leave one replace-a-word code unexplained.
        push(out, 'Use \'BOOLEAN\' instead of \'LOGICAL\'', single(d.range, 'BOOLEAN'), d);
        break;
      case 'missing-end-module': {
        // Anchor after the last non-blank line, indented like the module
        // header the diagnostic sits on (`END MODULE;` matches its CREATE).
        const header = d.range.start.line;
        let last = rawLines.length - 1;
        while (last > header && !rawLines[last].trim()) last--;
        push(
          out,
          'Add missing \'END MODULE;\'',
          single(at(last, rawLines[last].length), `\n${indentOf(rawLines[header] ?? '')}END MODULE;`),
          d
        );
        break;
      }
      case 'no-propagation': {
        // The same block walk the check itself does: the END that closes
        // Main's BEGIN is where `RETURN TRUE;` still runs.
        const close = mainCloseLine(lines, d.range.start.line);
        if (!close) break;
        const indent = indentOf(lines[close.line] ?? '');
        const inline = close.col > indent.length; // `... ; END;` on one line
        push(
          out,
          'Add \'RETURN TRUE;\' to Main()',
          single(
            inline ? at(close.line, close.col) : at(close.line, 0),
            inline ? 'RETURN TRUE; ' : `${close.bodyIndent}RETURN TRUE;\n${indent}`
          ),
          d
        );
        break;
      }
      case 'output-root-properties': {
        const stmt = 'SET OutputRoot.Properties = InputRoot.Properties;';
        push(
          out,
          'Copy InputRoot.Properties to OutputRoot',
          { changes: { [uri]: [topOfScopeEdit(lines, rawLines, d.range.start.line, stmt, false)] } },
          d
        );
        break;
      }
      case 'undeclared-variable':
      case 'undeclared-read': {
        const name = nameAt(rawLines, d.range);
        if (!name) break;
        const decl = quotedIfNeeded(name);
        // Did-you-mean first for reads (it mirrors the message's own
        // suggestion); the DECLARE skeleton is the "it really is new" path.
        if (code === 'undeclared-read') {
          const candidates = didYouMean(
            name,
            readCandidateNames(text, facts.analysis, facts.workspaceSharedNames)
          ).slice(0, MAX_CANDIDATE_ACTIONS);
          for (const c of candidates) {
            push(out, `Use declared '${c}'`, single(d.range, c), d);
          }
        }
        // A `CAST(x AS T)` on the flagged line is the author's own type
        // statement — that variant leads; CHARACTER is the never-wrong
        // fallback. No type is ever invented (PLAN task 17).
        const cast = castHint(lines[d.range.start.line] ?? '');
        if (cast && cast !== 'CHARACTER') {
          push(
            out,
            `Declare '${name}' as ${cast} (from the CAST on this line)`,
            {
              changes: {
                [uri]: [topOfScopeEdit(lines, rawLines, d.range.start.line, `DECLARE ${decl} ${cast};`, true)],
              },
            },
            d
          );
        }
        push(
          out,
          `Declare '${name}' as CHARACTER`,
          {
            changes: {
              [uri]: [topOfScopeEdit(lines, rawLines, d.range.start.line, `DECLARE ${decl} CHARACTER;`, true)],
            },
          },
          d
        );
        break;
      }
      case 'missing-semicolon':
      case 'syntax-error': {
        // The semicolon family. The flat hint's range ends AT the insertion
        // point; both grammar phrasings carry their exact slot as the range
        // (`expected ';' here` insertions are zero-width at the slot, E-8's
        // "not terminated" range spans the slot itself), so their fix
        // anchors at the range start. `syntax-error` earns a fix only when
        // the message names `';'` — no other syntax damage has a fix here.
        if (code === 'syntax-error' && !d.message.includes(`expected ';'`)) break;
        const anchor = code === 'missing-semicolon' ? d.range.end : d.range.start;
        if ((rawLines[anchor.line] ?? '').slice(anchor.character, anchor.character + 1) === ';')
          break; // already terminated since the diagnostic was published
        push(out, 'Insert \';\'', single(at(anchor.line, anchor.character), ';'), d);
        break;
      }
      case 'unknown-routine': {
        const name = nameAt(rawLines, d.range);
        if (!name) break;
        const candidates = didYouMean(
          name,
          routineCandidateNames(text, facts.analysis, facts.workspaceRoutineNames)
        ).slice(0, MAX_CANDIDATE_ACTIONS);
        for (const c of candidates) {
          push(out, `Call '${c}' instead`, single(d.range, c), d);
        }
        break;
      }
      default:
        break; // codes without fixes (module-no-main, unclosed-main)
    }
  }
  return out;
}

function push(out: CodeAction[], title: string, workspaceEdit: { changes: Record<string, TextEdit[]> }, d: Diagnostic): void {
  // Literal, not `CodeAction.create`: the pinned typings expose CodeAction as
  // a pure interface (same 3.15-era vintage as task 16's changeAnnotations
  // cast). `diagnostics` points back at the finding this clears — what clients
  // group by and what makes "which squiggle does this fix" answerable.
  out.push({ title, kind: CodeActionKind.QuickFix, edit: workspaceEdit, diagnostics: [d] });
}

const indentOf = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? '';

/** The exact name a name-shaped diagnostic covers (its range is the name —
 * both paths made it so); the raw line view keeps quoted names readable. */
function nameAt(rawLines: string[], range: Range): string | null {
  const line = rawLines[range.start.line];
  if (!line) return null;
  const name = line.slice(range.start.character, range.end.character).trim();
  return name || null;
}

/** A name needing quotes (spaces, punctuation, leading digit) gets ESQL's
 * doubled-quote escaping, so the skeleton DECLARE is legal for it too. */
function quotedIfNeeded(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** The datatype the flagged line itself commits to: `CAST(x AS INTEGER)` →
 * INTEGER (uppercase, the way datatypes are written). First CAST wins. */
function castHint(maskedLine: string): string | null {
  const call = /\bCAST\s*\(([^()]*)\)/i.exec(maskedLine);
  if (!call) return null;
  const as = /\bAS\s+([A-Za-z_]\w*)/.exec(call[1]);
  return as ? as[1].toUpperCase() : null;
}

/**
 * A TextEdit inserting `stmt` at the head of the routine enclosing `line`:
 * after that routine's BEGIN line (indented like the body), inline right
 * after BEGIN or right before END when the body shares those lines. Declared
 * statements additionally refuse the inline cases — ACE wants declarations
 * before statements, so a DECLARE with no clean routine head falls back to
 * directly above the flagged line instead of squeezing in illegally.
 * No enclosing routine at all (module-level code): also above the line.
 */
function topOfScopeEdit(
  lines: string[],
  rawLines: string[],
  line: number,
  stmt: string,
  declaration: boolean
): TextEdit {
  const above = (): TextEdit => {
    const indent = indentOf(rawLines[line] ?? '');
    return {
      range: Range.create(line, indent.length, line, indent.length),
      newText: `${stmt}\n${indent}`,
    };
  };
  const scope = hintScopes(lines).find((s) => line >= s.start && line <= s.end);
  if (!scope) return above();
  let begin = -1;
  for (let j = scope.start; j <= scope.end; j++) {
    if (findBeginToken(lines[j]) >= 0) {
      begin = j;
      break;
    }
  }
  if (begin < 0) return above(); // bodyless (damaged) routine: stay local
  const bc = findBeginToken(lines[begin]);
  const ec = findEndToken(lines[begin]);
  const bareBegin = ec < 0 && !lines[begin].slice(bc + 'BEGIN'.length).trim();
  if (!bareBegin && declaration) return above();
  if (ec >= 0 && ec > bc)
    return { range: Range.create(begin, ec, begin, ec), newText: `${stmt} ` };
  if (!bareBegin)
    return {
      range: Range.create(begin, bc + 'BEGIN'.length, begin, bc + 'BEGIN'.length),
      newText: ` ${stmt}`,
    };
  const indent = indentOf(rawLines[begin]);
  return {
    range: Range.create(begin, (rawLines[begin] ?? '').length, begin, (rawLines[begin] ?? '').length),
    newText: `\n${indent}  ${stmt}`,
  };
}

/**
 * The END that closes Main's BEGIN block, from the header line the
 * `no-propagation` diagnostic points at — deliberately the same line walk as
 * `checkPropagateOrReturn` (BEGIN +1 / bare-END −1, first END at depth 0):
 * the fix must believe exactly what the warning believed.
 */
function mainCloseLine(
  lines: string[],
  headerLine: number
): { line: number; col: number; bodyIndent: string } | null {
  let depth = 0;
  let bodySeen = false;
  let beginLine = -1;
  for (let i = headerLine; i < lines.length; i++) {
    if (findBeginToken(lines[i]) >= 0) {
      if (!bodySeen) beginLine = i;
      bodySeen = true;
      depth++;
    }
    const ec = findEndToken(lines[i]);
    if (ec >= 0) {
      depth--;
      if (depth <= 0 && bodySeen) {
        // The body's own indentation, from its first real statement — the
        // inserted RETURN should look like it was always there.
        let bodyIndent = '';
        for (let j = beginLine + 1; j < i; j++) {
          if (lines[j].trim()) {
            bodyIndent = indentOf(lines[j]);
            break;
          }
        }
        if (!bodyIndent) bodyIndent = `${indentOf(lines[i])}  `;
        return { line: i, col: ec, bodyIndent };
      }
    }
  }
  return null;
}
