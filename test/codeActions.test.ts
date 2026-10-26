/**
 * Quick-fix unit tests (PLAN task 17 / CODE_REVIEW.md E-9).
 *
 * Every transform gets: the action list for a published diagnostic (titles,
 * anchors, newText) AND the honest round trip — apply the edit to the source
 * and re-run the checks, the finding must be GONE. A fix that only "looks
 * right" in its TextEdit is exactly the false confidence this file exists to
 * prevent. The settings-toggle case feeds a diagnostic the server published
 * while the check was ON, with the check now OFF — the fix must obey the
 * toggle, not the echo (the e2e file owns the over-stdio versions).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Diagnostic, TextEdit } from 'vscode-languageserver';
import { analyze, DiagnosticCode } from '../src/diagnostics';
import { buildCodeActions } from '../src/codeActions';
import { parse, analyzeDocument } from '../src/parser';
import { DEFAULT_SETTINGS, EsqlDiagnosticsSettings } from '../src/settings';
import { skipWithoutGrammar } from './grammarStatus';

const D = DEFAULT_SETTINGS.diagnostics;
const URI = 'file:///fix/fixture.esql';

/** Everything the fix layer sees for one source: its diagnostics plus the
 * action list for every diagnostic carrying `code`. */
function fixView(
  source: string,
  code: DiagnosticCode,
  opts: {
    grammar?: boolean;
    settings?: EsqlDiagnosticsSettings;
    wsShared?: ReadonlySet<string>;
    wsRoutines?: ReadonlySet<string>;
    echoOnly?: Diagnostic[]; // bypass analyze(): hand the context list directly
  } = {}
) {
  const settings = opts.settings ?? D;
  let analysis;
  if (opts.grammar) {
    const tree = parse(source);
    assert.ok(tree, 'grammar fixture must parse for the tree path');
    analysis = analyzeDocument(tree, source);
  }
  const published = analyze(source, settings, analysis, opts.wsShared, opts.wsRoutines);
  const echoed = opts.echoOnly ?? published.filter((dx) => dx.code === code);
  const actions = buildCodeActions(URI, source, echoed, settings, {
    analysis,
    workspaceSharedNames: opts.wsShared,
    workspaceRoutineNames: opts.wsRoutines,
  });
  return { published, echoed, actions, titles: actions.map((a) => a.title) };
}

/** Apply single-file `changes` edits (descending) the way a client would. */
function applyEdits(text: string, edits: TextEdit[]): string {
  const offset = (pos: { line: number; character: number }): number => {
    const lines = text.split('\n');
    let off = 0;
    for (let i = 0; i < pos.line; i++) off += lines[i].length + 1;
    return off + pos.character;
  };
  let out = text;
  const sorted = [...edits].sort(
    (a, b) =>
      b.range.start.line - a.range.start.line ||
      b.range.start.character - a.range.start.character
  );
  for (const e of sorted) {
    out = out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end));
  }
  return out;
}

/** The fix's only edits, or fail. */
function editsOf(view: ReturnType<typeof fixView>): TextEdit[] {
  assert.equal(view.actions.length, 1, 'expected exactly one action');
  const changes = view.actions[0].edit?.changes;
  assert.ok(changes && changes[URI], 'the action carries a changes entry for the file');
  return changes[URI];
}

/** The contract every fix must survive: after applying it, the code is gone. */
function assertFixClears(
  source: string,
  code: DiagnosticCode,
  opts: Parameters<typeof fixView>[2] = {}
): string {
  const view = fixView(source, code, opts);
  const fixed = applyEdits(source, editsOf(view));
  const after = analyze(fixed, opts?.settings ?? D, undefined, opts?.wsShared, opts?.wsRoutines);
  assert.deepEqual(
    after.filter((dx) => dx.code === code).map((dx) => dx.message),
    [],
    `applying the '${code}' fix must clear the finding (fixed source:\n${fixed})`
  );
  return fixed;
}

// ── word replacements ───────────────────────────────────────────────────────

test('the deprecated-parser fix replaces exactly the XMLNS word', () => {
  const src = 'DECLARE x CHARACTER;\nSET x = InputRoot.XMLNS.Root.Data;\n';
  const view = fixView(src, 'deprecated-parser');
  assert.deepEqual(view.titles, ["Use 'XMLNSC' instead of 'XMLNS'"]);
  const edits = editsOf(view);
  assert.deepEqual(
    edits.map((e) => `${e.range.start.line}:${e.range.start.character}-${e.range.end.character}->${e.newText}`),
    ['1:18-23->XMLNSC']
  );
  assertFixClears(src, 'deprecated-parser');
});

test('the deprecated-type fix replaces exactly the LOGICAL slot', () => {
  const src = 'DECLARE flag LOGICAL;\n';
  const view = fixView(src, 'deprecated-type');
  assert.deepEqual(view.titles, ["Use 'BOOLEAN' instead of 'LOGICAL'"]);
  assert.deepEqual(editsOf(view).map((e) => e.newText), ['BOOLEAN']);
  assertFixClears(src, 'deprecated-type');
});

// ── insertions with placement rules ────────────────────────────────────────

const NO_END_MODULE = [
  'BROKER SCHEMA com.test;',
  'CREATE COMPUTE MODULE OpenMod',
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  '  RETURN TRUE;',
  'END;',
  '',
].join('\n');

test('the END MODULE fix appends at EOF, indented like the module header', () => {
  const view = fixView(NO_END_MODULE, 'missing-end-module');
  assert.deepEqual(view.titles, ["Add missing 'END MODULE;'"]);
  const fixed = assertFixClears(NO_END_MODULE, 'missing-end-module');
  assert.ok(fixed.endsWith('END;\nEND MODULE;\n'), `END MODULE lands after the last statement (got ${JSON.stringify(fixed.slice(-40))})`);

  const indented = NO_END_MODULE.replace('CREATE COMPUTE MODULE OpenMod', '  CREATE COMPUTE MODULE OpenMod');
  const view2 = fixView(indented, 'missing-end-module');
  const fixed2 = applyEdits(indented, editsOf(view2));
  assert.ok(fixed2.includes('\n  END MODULE;'), 'an indented module gets an indented END MODULE');
});

const NO_RETURN = [
  'BROKER SCHEMA com.test;',
  'CREATE COMPUTE MODULE NoReturnMod',
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  '  DECLARE x INTEGER;',
  '  SET x = 1;',
  'END;',
  'END MODULE;',
  '',
].join('\n');

test('the no-propagation fix inserts RETURN TRUE inside Main at body indent', () => {
  const view = fixView(NO_RETURN, 'no-propagation');
  assert.deepEqual(view.titles, ["Add 'RETURN TRUE;' to Main()"]);
  const fixed = assertFixClears(NO_RETURN, 'no-propagation');
  assert.ok(
    fixed.includes('  SET x = 1;\n  RETURN TRUE;\nEND;'),
    `RETURN lands last in the body at body indent (got ${JSON.stringify(fixed)})`
  );
});

test('the no-propagation fix keeps a one-line body on its line', () => {
  const src = [
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN DECLARE x INTEGER; SET x = 1; END;',
    '',
  ].join('\n');
  const view = fixView(src, 'no-propagation');
  const fixed = applyEdits(src, editsOf(view));
  assert.equal(
    fixed,
    [
      'CREATE FUNCTION Main() RETURNS BOOLEAN',
      'BEGIN DECLARE x INTEGER; SET x = 1; RETURN TRUE; END;',
      '',
    ].join('\n')
  );
});

// The scope MENTIONS Properties (the check only hints then) but never
// copies it: `SET temp = InputRoot.Properties...` is a read of the incoming
// properties, not the copy the hint asks for.
const NO_PROPS = [
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  '  DECLARE x INTEGER;',
  '  DECLARE temp CHARACTER;',
  '  SET temp = InputRoot.Properties.Name;',
  '  SET OutputRoot.JSON.Data.a = x;',
  '  RETURN TRUE;',
  'END;',
  '',
].join('\n');

test('the Properties fix inserts the copy line at the routine head', () => {
  const view = fixView(NO_PROPS, 'output-root-properties');
  assert.deepEqual(view.titles, ['Copy InputRoot.Properties to OutputRoot']);
  const fixed = assertFixClears(NO_PROPS, 'output-root-properties');
  assert.ok(
    fixed.includes(
      'BEGIN\n  SET OutputRoot.Properties = InputRoot.Properties;\n  DECLARE x INTEGER;'
    ),
    `the copy sits right below BEGIN (got ${JSON.stringify(fixed)})`
  );
});

// ── the DECLARE skeleton family ─────────────────────────────────────────────

const CAST_VAR = [
  'BROKER SCHEMA com.test;',
  'CREATE COMPUTE MODULE CastMod',
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  '  DECLARE x INTEGER;',
  '  SET x = 1;',
  '  SET total = CAST(x AS INTEGER);',
  '  RETURN TRUE;',
  'END;',
  'END MODULE;',
  '',
].join('\n');

test('undeclared SET target: CAST-hinted DECLARE first, CHARACTER as the fallback', () => {
  const view = fixView(CAST_VAR, 'undeclared-variable');
  assert.deepEqual(view.titles, [
    "Declare 'total' as INTEGER (from the CAST on this line)",
    "Declare 'total' as CHARACTER",
  ]);
  const skeleton = view.actions[1].edit?.changes?.[URI] ?? [];
  assert.deepEqual(
    skeleton.map((e) => `${e.range.start.line}:${e.range.start.character}->${JSON.stringify(e.newText)}`),
    ['3:5->"\\n  DECLARE total CHARACTER;"'],
    'the skeleton goes below BEGIN with the body indent'
  );
  const fixed = applyEdits(CAST_VAR, view.actions[0].edit?.changes?.[URI] ?? []);
  assert.ok(fixed.includes('  DECLARE total INTEGER;'));
  const after = analyze(fixed, D);
  assert.deepEqual(after.filter((dx) => dx.code === 'undeclared-variable'), []);
});

test('without a CAST on the flagged line only CHARACTER is offered — no invented types', () => {
  const src = CAST_VAR.replace('SET total = CAST(x AS INTEGER);', 'SET total = 7;');
  const view = fixView(src, 'undeclared-variable');
  assert.deepEqual(view.titles, ["Declare 'total' as CHARACTER"]);
});

test('the CAST must be on the flagged line, not elsewhere in the routine', () => {
  const src = [
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  DECLARE x INTEGER;',
    '  SET other = CAST(x AS INTEGER) + 1;',
    '  RETURN TRUE;',
    'END;',
    '',
  ].join('\n');
  const view = fixView(src, 'undeclared-variable'); // flags 'other' on the CAST line
  assert.deepEqual(view.titles, [
    "Declare 'other' as INTEGER (from the CAST on this line)",
    "Declare 'other' as CHARACTER",
  ]);
  // The same file, but the flagged SET does NOT carry the CAST.
  const src2 = src.replace(
    '  SET other = CAST(x AS INTEGER) + 1;',
    '  SET other = 1;\n  SET x = CAST(x AS INTEGER);'
  );
  const view2 = fixView(src2, 'undeclared-variable');
  assert.deepEqual(view2.titles, ["Declare 'other' as CHARACTER"]);
});

test('a quoted name gets a quoted skeleton DECLARE back', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // Quoted SET targets are invisible to the FLAT undeclared check (a miss,
  // never a fabrication) — the tree flags the quoted write's name, and the
  // skeleton DECLARE must quote it back.
  const src = [
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  SET "my var" = 1;',
    '  RETURN TRUE;',
    'END;',
    '',
  ].join('\n');
  const view = fixView(src, 'undeclared-read', { grammar: true });
  assert.deepEqual(view.titles, ["Declare 'my var' as CHARACTER"]);
  assert.deepEqual(
    (view.actions[0].edit?.changes?.[URI] ?? []).map((e) => `${e.range.start.line}:${e.range.start.character}->${JSON.stringify(e.newText)}`),
    ['1:5->"\\n  DECLARE \\"my var\\" CHARACTER;"']
  );
});

// ── did-you-mean replacements ───────────────────────────────────────────────

const READ_TYPO = [
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  '  DECLARE Counter INTEGER;',
  '  DECLARE y INTEGER;',
  '  SET y = Countr + 1;',
  '  RETURN TRUE;',
  'END;',
  '',
].join('\n');

test('an undeclared read offers the declared candidate first, then a skeleton', () => {
  const view = fixView(READ_TYPO, 'undeclared-read');
  assert.deepEqual(view.titles, ["Use declared 'Counter'", "Declare 'Countr' as CHARACTER"]);
  const first = view.actions[0].edit?.changes?.[URI] ?? [];
  assert.deepEqual(
    first.map((e) => `${e.range.start.line}:${e.range.start.character}-${e.range.end.character}->${JSON.stringify(e.newText)}`),
    ['4:10-16->"Counter"'],
    'the replacement covers exactly the flagged read'
  );
  const fixed = applyEdits(READ_TYPO, first);
  assert.deepEqual(
    analyze(fixed, D).filter((dx) => dx.code === 'undeclared-read'),
    [],
    'using the declared name clears the read warning'
  );
});

test('read suggestions are the same actions in grammar mode', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const view = fixView(READ_TYPO, 'undeclared-read', { grammar: true });
  assert.deepEqual(view.titles, ["Use declared 'Counter'", "Declare 'Countr' as CHARACTER"]);
});

test('at most three did-you-mean actions, nearest first', () => {
  const src = [
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  DECLARE ab INTEGER;',
    '  DECLARE abc INTEGER;',
    '  DECLARE abce INTEGER;',
    '  DECLARE abdf INTEGER;',
    '  DECLARE abxz INTEGER;',
    '  DECLARE v INTEGER;',
    '  SET v = abcd + ab;',
    '  RETURN TRUE;',
    'END;',
    '',
  ].join('\n');
  const view = fixView(src, 'undeclared-read');
  // 'abcd' is the undeclared read. Distances: abc=1, abce=1, ab=2, abdf=2,
  // abxz=2 — didYouMean sorts by distance and keeps list order on ties, so
  // the three actions are abc, abce, ab, and abdf/abxz never appear.
  assert.deepEqual(
    view.titles.filter((ti) => ti.startsWith('Use declared')),
    ["Use declared 'abc'", "Use declared 'abce'", "Use declared 'ab'"]
  );
  assert.ok(view.titles.includes("Declare 'abcd' as CHARACTER"), 'the skeleton follows the candidates');
});

const CALL_TYPO = [
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  '  CALL Helpr(1);',
  '  RETURN TRUE;',
  'END;',
  '',
].join('\n');

test('an unknown routine offers the workspace routine by name', () => {
  const ws = new Set(['Helper']);
  const view = fixView(CALL_TYPO, 'unknown-routine', { wsRoutines: ws });
  assert.deepEqual(view.titles, ["Call 'Helper' instead"]);
  const fixed = assertFixClears(CALL_TYPO, 'unknown-routine', { wsRoutines: ws });
  assert.ok(fixed.includes('CALL Helper(1);'));
});

test('routine suggestions are the same actions in grammar mode', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const view = fixView(CALL_TYPO, 'unknown-routine', { grammar: true, wsRoutines: new Set(['Helper']) });
  assert.deepEqual(view.titles, ["Call 'Helper' instead"]);
});

// ── the semicolon family ────────────────────────────────────────────────────

test('the missing-semicolon hint gets an append-the-semicolon fix', () => {
  const src = 'DECLARE x INTEGER;\nSET x = 1\nDECLARE y INTEGER;\n';
  const view = fixView(src, 'missing-semicolon');
  assert.deepEqual(view.titles, ["Insert ';'"]);
  const fixed = assertFixClears(src, 'missing-semicolon');
  assert.ok(fixed.includes('SET x = 1;\n'));
});

test('a stale echo whose line already ends in ; gets no semicolon action', () => {
  const src = 'DECLARE x INTEGER;\nSET x = 1\nDECLARE y INTEGER;\n';
  const stale = analyze(src, D).find((dx) => dx.code === 'missing-semicolon');
  assert.ok(stale, 'the hint exists to be echoed');
  const fixed = applyEdits(src, (fixView(src, 'missing-semicolon').actions[0].edit?.changes?.[URI] ?? []));
  // Feed the SAME diagnostic against text that already carries the `;`.
  const view = fixView(fixed, 'missing-semicolon', { echoOnly: [stale] });
  assert.deepEqual(view.titles, [], 'the anchor already holds a ; — no double insert');
});

test('a grammar syntax error naming the semicolon gets the insert; other damage does not', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // `SET x = 1` then a following terminated statement is the E-8 shape:
  // `Statement is not terminated — expected ';' here.` spanning the slot.
  const missing = 'DECLARE x INTEGER;\nCREATE PROCEDURE P()\nBEGIN\n  SET x = 1\n  SET x = 2;\nEND;\n';
  const view = fixView(missing, 'syntax-error', { grammar: true });
  const semis = view.published.filter((dx) => dx.code === 'syntax-error' && dx.message.includes(`expected ';'`));
  assert.ok(semis.length > 0, `the grammar names the missing ';' (got ${JSON.stringify(view.published.map((d) => d.message))})`);
  assert.deepEqual(view.titles, Array(semis.length).fill("Insert ';'"), 'one insert per semicolon-shaped syntax error, none for anything else');

  const other = 'DECLARE x INTEGER;\nSET x = @(1);\n';
  const view2 = fixView(other, 'syntax-error', { grammar: true });
  assert.ok(
    view2.published.some((dx) => dx.code === 'syntax-error'),
    'the file really is broken'
  );
  assert.deepEqual(
    view2.published.filter((dx) => dx.code === 'syntax-error' && dx.message.includes(`expected ';'`)).length,
    0,
    'and the damage is not semicolon-shaped'
  );
  assert.deepEqual(view2.titles, [], 'non-semicolon syntax errors carry no fix');
});

// ── who may NOT get a fix ───────────────────────────────────────────────────

test('fixes obey the owning check toggle even for an echoed diagnostic', () => {
  const src = 'DECLARE flag LOGICAL;\n';
  const echo = analyze(src, D).find((dx) => dx.code === 'deprecated-type');
  assert.ok(echo);
  const view = fixView(src, 'deprecated-type', {
    settings: { ...D, checkDeprecatedTypes: false },
    echoOnly: [echo],
  });
  assert.deepEqual(view.titles, [], 'the check is off, so its fix is off too');

  const src2 = 'DECLARE x CHARACTER;\nSET x = InputRoot.XMLNS.Root.Data;\n';
  const echo2 = analyze(src2, D).find((dx) => dx.code === 'deprecated-parser');
  const view2 = fixView(src2, 'deprecated-parser', {
    settings: { ...D, checkDeprecatedParsers: false },
    echoOnly: [echo2!],
  });
  assert.deepEqual(view2.titles, []);
});

test('the master switch kills every fix', () => {
  const echo = analyze(NO_RETURN, D).find((dx) => dx.code === 'no-propagation');
  assert.ok(echo);
  const view = fixView(NO_RETURN, 'no-propagation', {
    settings: { ...D, enabled: false },
    echoOnly: [echo],
  });
  assert.deepEqual(view.titles, []);
});

test('module-no-main and unclosed-main get no fix — the file needs a human', () => {
  const noMain = [
    'BROKER SCHEMA com.test;',
    'CREATE COMPUTE MODULE NoMainMod',
    'CREATE FUNCTION Helper() RETURNS BOOLEAN',
    'BEGIN',
    '  RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const view = fixView(noMain, 'module-no-main');
  assert.ok(view.published.some((dx) => dx.code === 'module-no-main'));
  assert.deepEqual(view.titles, []);
});

test("another extension's diagnostics are not ours to fix, and foreign codes are ignored", () => {
  const echo = analyze(NO_RETURN, D).find((dx) => dx.code === 'no-propagation');
  assert.ok(echo);
  assert.deepEqual(fixView(NO_RETURN, 'no-propagation', { echoOnly: [{ ...echo, source: 'other' }] }).titles, []);
  assert.deepEqual(
    fixView(NO_RETURN, 'no-propagation', { echoOnly: [{ ...echo, code: 'who-knows' }] }).titles,
    []
  );
});

test('the actions point back at the diagnostic they clear', () => {
  const view = fixView(NO_RETURN, 'no-propagation');
  assert.equal(view.actions[0].diagnostics?.length, 1);
  assert.equal(view.actions[0].diagnostics?.[0].message, view.published.find((dx) => dx.code === 'no-propagation')?.message);
  assert.equal(view.actions[0].kind, 'quickfix');
});
