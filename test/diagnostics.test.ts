import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { analyze } from '../src/diagnostics';
import { parse, analyzeDocument } from '../src/parser';
import { DEFAULT_SETTINGS } from '../src/settings';
import { skipWithoutGrammar } from './grammarStatus';

const D = DEFAULT_SETTINGS.diagnostics;

/** Returns messages grouped by severity for a source. */
function messages(source: string): { errors: string[]; warnings: string[]; hints: string[] } {
  const diags = analyze(source, D);
  const out = { errors: [] as string[], warnings: [] as string[], hints: [] as string[] };
  for (const d of diags) {
    if (d.severity === DiagnosticSeverity.Error) out.errors.push(d.message);
    else if (d.severity === DiagnosticSeverity.Warning) out.warnings.push(d.message);
    else if (d.severity === DiagnosticSeverity.Hint) out.hints.push(d.message);
  }
  return out;
}

const CLEAN_MODULE = [
  "BROKER SCHEMA com.test;",
  "CREATE COMPUTE MODULE TestModule",
  "BEGIN",
  "CREATE FUNCTION Main() RETURNS BOOLEAN",
  "BEGIN",
  "SET OutputRoot.Properties = InputRoot.Properties;",
  "SET OutputRoot.JSON.Data.msg = 'ok';",
  "PROPAGATE TO TERMINAL 'out';",
  "RETURN TRUE;",
  "END;",
  "END MODULE;",
  "",
].join('\n');

test('clean module produces no diagnostics', () => {
  const { errors, warnings, hints } = messages(CLEAN_MODULE);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(hints, []);
});

test('missing END MODULE is an error', () => {
  const src = CLEAN_MODULE.replace('END MODULE;', '');
  const { errors } = messages(src);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing its closing 'END MODULE'/);
});

/**
 * CODE_REVIEW.md E-7: an unclosed module made the grammar answer the SAME
 * forgotten END MODULE twice — its own `Syntax error in a module
 * definition.` on the header line plus the structure check's
 * `missing-end-module`. The structure check words it better (it names the
 * module), so where both target an unclosed module's header the grammar's
 * phrasing is dropped — while the tree keeps describing the damage
 * (parser.test owns that message; the suppression lives in diagnostics).
 */
test('an unclosed module reports its missing END MODULE once, in both modes (E-7)', async (t) => {
  const src = [
    'CREATE COMPUTE MODULE Case13',
    '    CREATE FUNCTION Main() RETURNS BOOLEAN',
    '    BEGIN',
    '        SET neverDeclared = 1;',
    '',
  ].join('\n');
  const heur = analyze(src, D).filter((d) => /END MODULE/.test(d.message));
  assert.equal(heur.length, 1, 'the heuristic baseline both modes must match');
  assert.match(heur[0].message, /missing its closing 'END MODULE'/);
  if (!(await skipWithoutGrammar(t))) return;
  const doc = analyzeDocument(parse(src)!, src);
  assert.ok(
    doc.syntaxIssues.some((i) => i.message === 'Syntax error in a module definition.'),
    JSON.stringify(doc.syntaxIssues.map((i) => i.message))
  );
  const grammar = analyze(src, D, doc);
  const gEnd = grammar.filter((d) => /END MODULE/.test(d.message));
  assert.equal(gEnd.length, 1, 'one diagnostic per root cause');
  assert.equal(gEnd[0].message, heur[0].message, 'the better-worded one');
  assert.equal(gEnd[0].range.start.line, heur[0].range.start.line);
  assert.ok(
    !grammar.some((d) => /module definition/.test(d.message)),
    JSON.stringify(grammar.map((d) => d.message))
  );
});

test('a damaged header of a CLOSED module keeps its syntax message (E-7 targets)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // Suppression is targeted — same line AND a missing END MODULE. A closed
  // module cannot fire `missing-end-module`, so nothing else would ever
  // report this broken header; dropping the grammar message here would
  // silently lose a check, which is the failure this test exists for.
  const src = [
    'CREATE COMPUTE MODULE %%%',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const doc = analyzeDocument(parse(src)!, src);
  const grammar = analyze(src, D, doc);
  assert.ok(
    grammar.some(
      (d) => d.code === 'syntax-error' && /Syntax error in a module definition\./.test(d.message)
    ),
    JSON.stringify(grammar.map((d) => [d.code, d.message]))
  );
  assert.ok(!grammar.some((d) => d.code === 'missing-end-module'), 'the module IS closed');
});

test('mined names quiet the undeclared check exactly where they should (E-2)', async (t) => {
  // The E-2 regression probe as a standing test: one forgotten `;` above
  // the module used to make the CORRECTLY declared SHARED look undeclared
  // in grammar mode. The heuristic pass declares everything it can see
  // (flat set), so its warning list is the reference the tree path — with
  // its mining of the damaged region — must now reproduce.
  const src = [
    'BROKER SCHEMA com.acme.e2;',
    '',
    'DECLARE FailureCount SHARED INTEGER',
    '',
    'CREATE COMPUTE MODULE E2Module',
    '',
    '  CREATE FUNCTION Main() RETURNS BOOLEAN',
    '  BEGIN',
    '    DECLARE local INTEGER;',
    '    SET FailureCount = 1;',
    '    SET local = 2;',
    '    SET neverSeen = 3;',
    '    RETURN TRUE;',
    '  END;',
    '',
    'END MODULE',
    '',
  ].join('\n');
  const { warnings } = messages(src);
  assert.deepEqual(
    warnings,
    ["Variable 'neverSeen' is used in SET but never declared with DECLARE."],
    'heuristic mode: the one name with no DECLARE'
  );
  if (!(await skipWithoutGrammar(t))) return;
  const doc = analyzeDocument(parse(src)!, src);
  const gWarnings = analyze(src, D, doc)
    .filter((d) => d.severity === DiagnosticSeverity.Warning)
    .map((d) => d.message);
  assert.deepEqual(gWarnings, warnings, 'both modes agree on what is declared inside the damage');
});

test('module without Main() is a warning', () => {
  const src = [
    'BROKER SCHEMA com.test;',
    'CREATE COMPUTE MODULE NoMain',
    'BEGIN',
    'END MODULE;',
    '',
  ].join('\n');
  const { warnings } = messages(src);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no Main\(\) function/);
});

test('Main() without RETURN/PROPAGATE is a warning', () => {
  const src = [
    'BROKER SCHEMA com.test;',
    'CREATE COMPUTE MODULE M',
    'BEGIN',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    "SET OutputRoot.Properties = InputRoot.Properties;",
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const { warnings } = messages(src);
  assert.ok(warnings.some((w) => /neither RETURN nor PROPAGATE/.test(w)));
});

test('undeclared variable in SET is a warning (case-insensitive)', () => {
  const withDecl = [
    'DECLARE foo CHARACTER;',
    'SET foo = \'x\';',
    '',
  ].join('\n');
  assert.deepEqual(messages(withDecl).warnings, []);

  const undeclared = 'SET foo = \'x\';\n';
  const w1 = messages(undeclared).warnings;
  assert.equal(w1.length, 1);
  assert.match(w1[0], /Variable 'foo'/);

  // DECLARE with different case must suppress the warning.
  const mixedCase = 'DECLARE FOO CHARACTER;\nSET foo = \'x\';\n';
  assert.deepEqual(messages(mixedCase).warnings, []);
});

test('tree root assignments are not flagged as undeclared', () => {
  const src = [
    'SET OutputRoot.Properties = InputRoot.Properties;',
    'SET OutputRoot.JSON.Data.x = 1;',
    'SET Environment.myVar = 1;',
    '',
  ].join('\n');
  assert.deepEqual(messages(src).warnings, []);
});

test('deprecated XMLNS parser is a warning, XMLNSC is not', () => {
  const bad = "DECLARE x CHARACTER;\nSET x = InputRoot.XMLNS.Root.Data;\n";
  const w = messages(bad).warnings;
  assert.ok(w.some((m) => /XMLNSC/.test(m)));

  const good = "DECLARE x CHARACTER;\nSET x = InputRoot.XMLNSC.Root.Data;\n";
  assert.deepEqual(messages(good).warnings, []);
});

test('missing semicolon is a hint', () => {
  const bad = 'SET OutputRoot.Properties = InputRoot.Properties\n';
  const hints = messages(bad).hints;
  assert.equal(hints.length, 1);
  assert.match(hints[0], /missing semicolon/);

  const good = 'SET OutputRoot.Properties = InputRoot.Properties;\n';
  assert.equal(messages(good).hints.length, 0);
});

test('strings cannot fake END MODULE or trigger false positives', () => {
  const src = [
    'BROKER SCHEMA com.test;',
    'CREATE COMPUTE MODULE M',
    'BEGIN',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    "SET OutputRoot.Properties = InputRoot.Properties;",
    "SET x = 'END MODULE; BEGIN SET y = 1';",
    "SET y = '2024-01-15 -- not a comment';",
    "PROPAGATE TO TERMINAL 'out';",
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const { errors, warnings } = messages(src);
  assert.deepEqual(errors, []);
  // The SET y line ends with a string containing '--' — must not look
  // unterminated, and no fake structure issues.
  assert.ok(warnings.every((w) => !/END MODULE/.test(w)));
});

test('multi-line THROW is not flagged as missing semicolon', () => {
  const src = [
    'THROW USER EXCEPTION',
    '\tMESSAGE 2951',
    '\tSEVERITY 3',
    "\tCATALOG 'BIPmsgs'",
    "\tVALUES('err');",
    '',
  ].join('\n');
  assert.equal(messages(src).hints.length, 0);
});

test('OutputRoot JSON hint: one per routine, and only when Properties is in play', () => {
  // Real-world shape (ISSUES.md I-7): a routine that reads Properties but never
  // copies it, then builds a JSON body field by field. The advice is right once
  // and useless eighteen times, so it is reported at the first offending SET.
  const noCopy = [
    'CREATE COMPUTE MODULE M', //                              0
    'CREATE FUNCTION Main() RETURNS BOOLEAN', //               1
    'BEGIN', //                                                2
    'DECLARE ccsid INTEGER InputRoot.Properties.CodedCharSetId;', // 3
    'SET OutputRoot.JSON.Data.a = 1;', //                      4  <- hinted here
    'SET OutputRoot.JSON.Data.b = 2;', //                      5
    'SET OutputRoot.JSON.Data.c = 3;', //                      6
    'RETURN TRUE;', //                                         7
    'END;', //                                                 8
    'END MODULE;', //                                          9
    '',
  ].join('\n');
  const hints = analyze(noCopy, D).filter(
    (d) => d.severity === DiagnosticSeverity.Hint && /Properties/.test(d.message)
  );
  assert.equal(hints.length, 1);
  assert.equal(hints[0].range.start.line, 4);

  // A request-building node (HTTP/MQ reply) that never touches Properties has
  // nothing to copy: no hint at all.
  const requestBuilder = [
    'CREATE COMPUTE MODULE M',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    "SET OutputLocalEnvironment.Destination.HTTP.RequestURL = 'https://x/y';",
    'SET OutputRoot.JSON.Data.a = 1;',
    'SET OutputRoot.JSON.Data.b = 2;',
    'RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  assert.deepEqual(
    analyze(requestBuilder, D).filter((d) => /no copy of Properties/.test(d.message)),
    []
  );

  // Copying Properties (whole root or field by field) silences it.
  const withCopy = [
    'SET OutputRoot.Properties = InputRoot.Properties;',
    'SET OutputRoot.JSON.Data.x = 1;',
    '',
  ].join('\n');
  assert.deepEqual(
    analyze(withCopy, D).filter((d) => /no copy of Properties/.test(d.message)),
    []
  );

  // Grouping is per routine, not per file: two offenders, two hints.
  const twoRoutines = [
    'CREATE COMPUTE MODULE M',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'DECLARE c INTEGER InputRoot.Properties.CodedCharSetId;',
    'SET OutputRoot.JSON.Data.a = 1;',
    'RETURN TRUE;',
    'END;',
    'CREATE FUNCTION Helper() RETURNS BOOLEAN',
    'BEGIN',
    'DECLARE d INTEGER InputRoot.Properties.Encoding;',
    'SET OutputRoot.JSON.Data.b = 2;',
    'RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const perRoutine = analyze(twoRoutines, D).filter((d) =>
    /no copy of Properties/.test(d.message)
  );
  assert.deepEqual(perRoutine.map((d) => d.range.start.line), [4, 10]);
});

test('a namespace-declaration prefix is not the deprecated XMLNS parser', () => {
  // Both spellings of the standard namespace-declaration idiom, straight out of
  // the real samples that used to warn (ISSUES.md I-8): the `xmlns` here is a
  // prefix NAME, not the ACE v9 `XMLNS` parser.
  const decls = [
    'SET OutputRoot.XMLNSC.tns:SayHelloResponse.(XMLNSC.NamespaceDecl)xmlns:tns = tns;',
    "SET OutputRoot.XMLNSC.tns:R.(XMLNSC.NamespaceDecl)xmlns = 'urn:hl7-org:v2xml';",
    '',
  ].join('\n');
  assert.deepEqual(messages(decls).warnings, []);

  // The real deprecation still warns, at the `XMLNS` word itself.
  const parser = 'SET OutputRoot.XMLNS.Root.Data = 1;\n';
  const diags = analyze(parser, D).filter(
    (d) => d.severity === DiagnosticSeverity.Warning && /XMLNSC/.test(d.message)
  );
  assert.equal(diags.length, 1);
  assert.equal(
    parser.split('\n')[0].slice(diags[0].range.start.character, diags[0].range.end.character),
    'XMLNS'
  );
});

test('missing-semicolon hint ignores continuations and covers the statement', () => {
  // Multi-line statements: the depth of open parens (and a trailing SELECT,
  // whose clauses follow on later lines) means "the statement goes on here",
  // not "it forgot its semicolon". These are the families that produced 13
  // bogus hints across 6 real files.
  const multiLine = [
    "DECLARE messageBlob BLOB ASBITSTREAM(OutputRoot.MRM",
    '    ENCODING InputRoot.Properties.Encoding',
    '    CCSID InputRoot.Properties.CodedCharSetId',
    "    SET ReceiverMessageSet TYPE ReceiverMessageType FORMAT 'IDOC');",
    'SET Environment.DB.EMPLOYEE[] = SELECT ',
    '    p.EMPNO, CURRENT_TIMESTAMP AS UPDATED_AT',
    '    FROM Database.S.EMPLOYEE AS p;',
    'SET P3.Data.BLOB.BLOB = CAST(BASE64ENCODE(InputRoot.BLOB.BLOB) ',
    '    AS BLOB) CCSID 1208;',
    '',
  ].join('\n');
  assert.deepEqual(
    analyze(multiLine, D).filter((d) => /missing semicolon/.test(d.message)),
    []
  );

  // A genuine one: the range spans the statement text, not the whitespace after
  // it, so the client underlines something the reader can act on.
  const missing = '\tSET OutputRoot.Properties = InputRoot.Properties\n';
  const hints = analyze(missing, D).filter((d) => /missing semicolon/.test(d.message));
  assert.equal(hints.length, 1);
  assert.equal(
    missing.split('\n')[0].slice(hints[0].range.start.character, hints[0].range.end.character),
    'SET OutputRoot.Properties = InputRoot.Properties'
  );

  // The operator can also be written at the START of the next line (Healthcare
  // TransportSender does exactly this): balanced parens, no trailing `;`, and
  // still not a missing semicolon.
  const below = [
    "\t\t\tSET ibmHCAttempt = 'Attempt ' || CAST((ibmHCRetryCount +1) as CHARACTER)",
    "\t\t\t\t|| ' OF ' || CAST(RetryLimit as CHARACTER);",
    '',
  ].join('\n');
  assert.deepEqual(
    analyze(below, D).filter((d) => /missing semicolon/.test(d.message)),
    []
  );

  // Same shape, but the next line starts a new statement: still flagged.
  const reallyMissing = [
    '\t\t\tSET ibmHCAttempt = 1',
    "\t\t\tPROPAGATE TO TERMINAL 'out';",
    '',
  ].join('\n');
  assert.equal(
    analyze(reallyMissing, D).filter((d) => /missing semicolon/.test(d.message)).length,
    1
  );
});

test('multi-name DECLARE declares every name', () => {
  const declared = "DECLARE a, b, c CHARACTER;\nSET b = 'x';\n";
  assert.deepEqual(messages(declared).warnings, []);

  // A name NOT in the list must still be flagged.
  const undeclared = "DECLARE a, b CHARACTER;\nSET c = 'x';\n";
  const w = messages(undeclared).warnings;
  assert.equal(w.length, 1);
  assert.match(w[0], /Variable 'c'/);

  // SHARED / CONSTANT modifiers between the name list and the type.
  const shared = 'DECLARE a, b SHARED INTEGER;\nSET a = 1;\n';
  assert.deepEqual(messages(shared).warnings, []);
  const constant = 'DECLARE x, y CONSTANT ROW;\nSET x = 1;\n';
  assert.deepEqual(messages(constant).warnings, []);
});

test('handler DECLARE declares no variable names', () => {
  // `DECLARE CONTINUE HANDLER …` must not leak CONTINUE/EXIT/handler
  // words into the declared-name set.
  const src = [
    "DECLARE CONTINUE HANDLER FOR SQLSTATE '05001'",
    "SET Environment.Note = 'handled';",
    '',
  ].join('\n');
  assert.deepEqual(messages(src).warnings, []);
});

test('the deprecated-parser and JSON hints each answer to their own setting', () => {
  const src = [
    'DECLARE ccsid INTEGER InputRoot.Properties.CodedCharSetId;',
    'SET OutputRoot.XMLNS.Root.Data = 1;',
    'SET OutputRoot.JSON.Data.a = 1;',
    '',
  ].join('\n');
  const XMLNS = "Parser 'XM"; // start of the deprecation message
  const JSOND = 'Building O'; // start of the JSON/Properties hint
  const heads = (settings: typeof D) => analyze(src, settings).map((d) => d.message.slice(0, 10));
  assert.deepEqual(heads(D), [XMLNS, JSOND]);
  assert.deepEqual(heads({ ...D, checkDeprecatedParsers: false }), [JSOND]);
  assert.deepEqual(heads({ ...D, checkOutputRootProperties: false }), [XMLNS]);
});

// ── E-3: the legacy LOGICAL datatype — the hint side (grammar side lives in
// parser.test; the defect was the two paths DISAGREEING) ────────────────────

const LOGICAL_MODULE = [
  'CREATE COMPUTE MODULE LegacyTypes',
  '    CREATE FUNCTION Main() RETURNS BOOLEAN',
  '    BEGIN',
  '        DECLARE flag LOGICAL;',
  '        SET flag = TRUE;',
  '        RETURN TRUE;',
  '    END;',
  'END MODULE;',
  '',
].join('\n');

const LOGICAL_HINT = "Data type 'LOGICAL' is legacy ESQL and deprecated. Use 'BOOLEAN' in ACE 12.";

test('legacy LOGICAL gets the deprecated-type hint, nothing else fires', () => {
  const { errors, warnings, hints } = messages(LOGICAL_MODULE);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(hints, [LOGICAL_HINT]);
});

test('the hint lives in the datatype slot, not the word (E-3 regex precision)', () => {
  // A variable NAMED logical is not a deprecated type; SHARED/EXTERNAL sit
  // between name and type per the railroad and must not hide the type.
  const named = ['DECLARE logical INTEGER;', 'SET logical = 1;', ''].join('\n');
  assert.equal(messages(named).hints.length, 0, 'name slot, not type slot');
  const shared = ['DECLARE TraceEnabled SHARED LOGICAL TRUE;', ''].join('\n');
  assert.deepEqual(messages(shared).hints, [LOGICAL_HINT]);
  const multi = ['DECLARE a, b LOGICAL;', ''].join('\n');
  assert.deepEqual(messages(multi).hints, [LOGICAL_HINT]);
});

test('the LOGICAL hint answers to checkDeprecatedTypes on its own', () => {
  const heads = (settings: typeof D) => analyze(LOGICAL_MODULE, settings).map((d) => d.message.slice(0, 10));
  assert.deepEqual(heads(D), ['Data type ']);
  assert.deepEqual(heads({ ...D, checkDeprecatedTypes: false }), []);
});

test('LOGICAL: grammar mode never says MORE than the fallback (E-3 probe)', async (t) => {
  const heur = analyze(LOGICAL_MODULE, D).map((d) => [d.code, d.message, d.range.start.line, d.range.start.character]);
  assert.deepEqual(heur, [['deprecated-type', LOGICAL_HINT, 3, 21]]);
  if (!(await skipWithoutGrammar(t))) return;
  const doc = analyzeDocument(parse(LOGICAL_MODULE)!, LOGICAL_MODULE);
  assert.deepEqual(doc.syntaxIssues, [], 'the false flag must not come back');
  const grammar = analyze(LOGICAL_MODULE, D, doc).map((d) => [d.code, d.message, d.range.start.line, d.range.start.character]);
  assert.deepEqual(grammar, heur, 'both paths agree line-for-line on legacy ESQL');
});

// ── E-4: unknown CALL/call targets ──────────────────────────────────────────

/**
 * One fixture for the whole check: the two genuine unknowns (lines 12/13)
 * plus everything the allow list must swallow — datatype precision words,
 * a workspace sibling, a forward-declared file routine, a clause builtin, a
 * qualified schema call, and keywords that precede `(`.
 */
const CALL_MODULE = [
  'BROKER SCHEMA com.test.e4;',
  'CREATE COMPUTE MODULE Caller',                        // 1
  'CREATE FUNCTION Main() RETURNS BOOLEAN',              // 2
  'BEGIN',                                               // 3
  '  DECLARE x INTEGER;',                                // 4
  '  DECLARE s CHARACTER VARYING(20);',                  // 5
  '  SET s = CAST(1 AS VARCHAR(10));',                   // 6
  '  SET x = Helper(1);',                                // 7  workspace sibling
  '  SET x = localFn(2);',                               // 8  file routine, forward
  '  CALL Helper(3);',                                   // 9
  '  CALL com.acme.SchemaProc(4);',                      // 10 qualified: outside any file set
  '  IF (x = 1) THEN SET x = 2; END IF;',                // 11
  '  SET x = DoesNotExist(5);',                          // 12 unknown, no candidate nearby
  '  CALL Helpr();',                                     // 13 typo → did-you-mean Helper
  '  RETURN TRUE;',                                      // 14
  'END;',                                                // 15
  'END MODULE;',                                         // 16
  '',                                                    // 17
  'CREATE FUNCTION localFn(p INTEGER) RETURNS INTEGER',  // 18
  'BEGIN RETURN p; END;',                                // 19
  '',
].join('\n');

const E4_WS = new Set(['Helper', 'OtherThing']);
const E4_UNKNOWN = (diags: ReturnType<typeof analyze>) =>
  diags
    .filter((d) => d.code === 'unknown-routine')
    .map((d) => `${d.message}@${d.range.start.line}:${d.range.start.character}`);

test('unknown CALL targets warn with did-you-mean; the allow list holds (E-4)', () => {
  const diags = analyze(CALL_MODULE, D, undefined, undefined, E4_WS);
  assert.deepEqual(E4_UNKNOWN(diags), [
    "Routine 'DoesNotExist' is not defined in this file or workspace.@12:10",
    "Routine 'Helpr' is not defined in this file or workspace. Did you mean 'Helper'?@13:7",
  ]);
  const typo = diags.find((d) => d.code === 'unknown-routine' && /Helpr/.test(d.message))!;
  assert.equal(typo.severity, DiagnosticSeverity.Warning);
});

test('without a workspace root the routine check says nothing (E-4/I-13 rule)', () => {
  // No workspace = no knowledge, NOT an error: the same text that warns with
  // the set must be silent without it.
  const bare = analyze(CALL_MODULE, D);
  assert.deepEqual(E4_UNKNOWN(bare), [], JSON.stringify(bare.map((d) => d.code)));
});

test('the check answers to checkUnknownRoutines alone', () => {
  const off = analyze(CALL_MODULE, { ...D, checkUnknownRoutines: false }, undefined, undefined, E4_WS);
  assert.deepEqual(E4_UNKNOWN(off), []);
  // the undeclared warning on `x` still… no: x IS declared; assert the
  // OTHER checks survive instead — zero diagnostics here means the fixture
  // is clean apart from the routine findings, which is the point.
  assert.equal(off.length, 0, 'the fixture is otherwise clean');
});

test('E-4 flags agree position-for-position between modes', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const doc = analyzeDocument(parse(CALL_MODULE)!, CALL_MODULE);
  assert.deepEqual(doc.syntaxIssues, [], 'the fixture must be grammatically clean for this comparison');
  const grammar = analyze(CALL_MODULE, D, doc, undefined, E4_WS);
  const heuristic = analyze(CALL_MODULE, D, undefined, undefined, E4_WS);
  assert.deepEqual(E4_UNKNOWN(grammar), E4_UNKNOWN(heuristic));
});

test('diagnostics can be disabled via settings', () => {
  // Module structure (ungated) is satisfied: Main() present, END MODULE present.
  const src = [
    'CREATE COMPUTE MODULE M',
    'BEGIN',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const allOff = {
    enabled: true,
    checkSyntaxErrors: false,
    checkUndeclaredVariables: false,
    checkPropagation: false,
    checkMissingSemicolon: false,
    checkDeprecatedParsers: false,
    checkDeprecatedTypes: false,
    checkUnknownRoutines: false,
    checkOutputRootProperties: false,
  };
  assert.deepEqual(analyze(src, allOff), []);
  assert.deepEqual(analyze(src, { ...allOff, enabled: false }), []);
});

/**
 * I-21: every finding is addressed by `source` + `code`. A client groups and
 * suppresses by those two fields, and the message is not a stable key; a
 * diagnostic without them is unaddressable. Asserted on both paths, because
 * the fallback is a sold mode, not a degraded extra.
 */
const MESSY = [
  'CREATE COMPUTE MODULE Messy', // 0 — no END MODULE anywhere
  'CREATE FUNCTION Main() RETURNS BOOLEAN', // 1
  'BEGIN', // 2
  'SET OutputRoot.XMLNS.Data.x = 1;', // 3 — deprecated parser
  'SET nowhere = 1', // 4 — undeclared, and no semicolon
  'RETURN 1;', // 5
  'END;', // 6
  '',
].join('\n');

const CODES = [
  'syntax-error',
  'module-no-main',
  'missing-end-module',
  'undeclared-variable',
  'no-propagation',
  'unclosed-main',
  'deprecated-parser',
  'missing-semicolon',
  'output-root-properties',
];

function assertAddressable(
  diags: readonly {
    source?: string;
    code?: string | number;
    message: string;
    codeDescription?: { href: string };
  }[],
  mode: string
) {
  assert.ok(diags.length >= 3, `${mode}: the fixture really produces findings`);
  for (const d of diags) {
    assert.equal(d.source, 'esql', `${mode}: \`${d.message}\` names its source`);
    assert.equal(typeof d.code, 'string', `${mode}: \`${d.message}\` carries a code`);
    assert.ok(CODES.includes(d.code as string), `${mode}: unknown code ${JSON.stringify(d.code)}`);
    assert.equal(
      d.codeDescription?.href,
      'https://github.com/nils-gg/esql-lsp#diagnostics',
      `${mode}: \`${d.message}\` links its code to the README section`
    );
  }
}

test('every heuristic diagnostic carries a source and a code', () => {
  assertAddressable(analyze(MESSY, D), 'heuristic');
  assert.deepEqual(
    analyze(MESSY, D).map((d) => d.code),
    ['missing-end-module', 'undeclared-variable', 'deprecated-parser', 'missing-semicolon'],
    'and the codes name the checks that fired'
  );
});

test('every grammar-backed diagnostic carries a source and a code', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const { parse, analyzeDocument } = await import('../src/parser');
  const tree = parse(MESSY)!;
  assertAddressable(analyze(MESSY, D, analyzeDocument(tree)), 'grammar');
});

/** ISSUES.md I-6: the module (and routine) is unclosed — mid-typing state. */
const CASE13 = [
  'CREATE COMPUTE MODULE Case13', //                 0
  '    CREATE FUNCTION Main() RETURNS BOOLEAN', //   1
  '    BEGIN', //                                    2
  '        DECLARE declaredVar INTEGER;', //         3
  '        SET declaredVar = 1;', //                 4
  '        SET neverDeclared = declaredVar;', //     5
  '        SET OutputRoot = InptuRoot;', //          6
  '',
].join('\n');

test('heuristic mode reports the undeclared name inside a damaged region (I-6)', () => {
  const diags = analyze(CASE13, D);
  assert.ok(
    diags.some((d) => d.code === 'undeclared-variable' && /neverDeclared/.test(d.message)),
    `fallback keeps answering mid-typing: ${JSON.stringify(diags.map((d) => d.code))}`
  );
});

test('grammar mode reports the undeclared name inside a damaged region (I-6)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const { parse, analyzeDocument } = await import('../src/parser');
  const diags = analyze(CASE13, D, analyzeDocument(parse(CASE13)!));
  // E-7 changed what "the damage is reported" means here: the grammar's
  // module-definition message defers to `missing-end-module` on the header
  // line (one diagnostic per root cause — the E-7 pair of tests pins both
  // sides). What must survive is the SEMANTIC check inside the damage.
  const endModule = diags.filter((d) => d.code === 'missing-end-module');
  assert.equal(endModule.length, 1, 'the damage itself is still reported — once');
  const undeclared = diags.filter((d) => d.code === 'undeclared-variable');
  assert.equal(undeclared.length, 1, JSON.stringify(diags.map((d) => [d.code, d.message])));
  assert.match(undeclared[0].message, /neverDeclared/);
  assert.equal(undeclared[0].range.start.line, 5, 'on the SET line, inside the damaged region');
});

// ISSUES.md I-13: a name declared `SHARED` in a SIBLING FILE is visible here
// too. The caller (server.ts) supplies the names; absent them the check keeps
// its file-local meaning — which every other test in this file asserts.
const USES_SHARED = [
  'CREATE COMPUTE MODULE UsesShared',
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  '  SET FailureCount = FailureCount + 1;',
  '  RETURN TRUE;',
  'END;',
  'END MODULE;',
  '',
].join('\n');

test('workspace SHARED names satisfy the undeclared check (I-13)', async (t) => {
  const shared = new Set(['FAILURECOUNT']);

  // Fallback path — asserted in BOTH modes: this is the surface a
  // toolchain-less machine gets, so it may not skip.
  const local = analyze(USES_SHARED, D);
  assert.ok(
    local.some((d) => d.code === 'undeclared-variable' && /FailureCount/.test(d.message)),
    'without a workspace view the file-local verdict stands'
  );
  const withWs = analyze(USES_SHARED, D, undefined, shared);
  assert.ok(
    !withWs.some((d) => d.code === 'undeclared-variable'),
    `a sibling declares it SHARED: ${JSON.stringify(withWs.map((d) => d.code))}`
  );

  // Tree path — grammar-only expectation, skips without the addon. Both
  // paths must agree on the SHARED verdict or the I-13 mechanism would
  // ship half a fix.
  if (await skipWithoutGrammar(t)) {
    const { parse, analyzeDocument } = await import('../src/parser');
    const doc = analyzeDocument(parse(USES_SHARED)!, USES_SHARED);
    assert.ok(
      analyze(USES_SHARED, D, doc).some((d) => d.code === 'undeclared-variable'),
      'the tree path also reports it without the workspace view'
    );
    const quiet = analyze(USES_SHARED, D, doc, shared);
    assert.ok(
      !quiet.some((d) => d.code === 'undeclared-variable'),
      `and silences it with the same set: ${JSON.stringify(quiet.map((d) => d.code))}`
    );
  }
});

// ── E-6: the fourth module kind is module-checked like the other three ─────

/**
 * The diagnostics' local MODULE_RE omitted DATABASEEVENT, so both structure
 * checks stayed silent on those modules while declarations/hover/completion
 * knew the kind. Now the matcher is imported from definitions.ts and every
 * CREATE … MODULE kind is checked.
 */
test('DATABASEEVENT modules get the same structure checks (E-6)', () => {
  const noMain = [
    'BROKER SCHEMA com.test;',
    'CREATE DATABASEEVENT MODULE DeNoMain',
    'BEGIN',
    'END MODULE;',
    '',
  ].join('\n');
  const { warnings } = messages(noMain);
  assert.ok(
    warnings.some((w) => /contains no Main\(\)/.test(w)),
    `module-no-main fires on DATABASEEVENT: ${JSON.stringify(warnings)}`
  );
  assert.ok(
    !warnings.some((w) => /missing its closing/.test(w)),
    'a closed DATABASEEVENT module is not reported unclosed'
  );

  const unclosed = [
    'BROKER SCHEMA com.test;',
    'CREATE DATABASEEVENT MODULE DeOpen',
    'BEGIN',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'END;',
    '',
  ].join('\n');
  const { errors } = messages(unclosed);
  assert.ok(
    errors.some((e) => /missing its closing 'END MODULE'/.test(e)),
    `missing-end-module fires on DATABASEEVENT: ${JSON.stringify(errors)}`
  );
});
