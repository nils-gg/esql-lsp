/**
 * Go-to-definition and find-references — grammar-backed and heuristic paths.
 *
 * These tests deliberately do NOT skip when the tree-sitter addon is missing:
 * the fallback is a supported mode (the README sells it), so its behaviour has
 * to be asserted even in an environment that only has the heuristics. Each
 * case runs in both modes whenever the grammar is loaded — the two must agree
 * on where a name is declared.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Range } from 'vscode-languageserver';
import { parse, analyzeDocument, DocAnalysis, grammarReady, initGrammar } from '../src/parser';
import {
  definitionAt,
  referencesAt,
  declarationsFromSource,
  routinesFromSource,
  rangeContains,
  visibleDeclarationsAt,
  declarationAt,
  enclosingRoutine,
} from '../src/definitions';

const SRC = [
  'BROKER SCHEMA com.acme.payments;',                                     // 0
  '',                                                                     // 1
  'CREATE COMPUTE MODULE PaymentRouter',                                  // 2
  '  CREATE FUNCTION Main() RETURNS BOOLEAN',                             // 3
  '  BEGIN',                                                              // 4
  '    CALL CopyHeader();',                                               // 5
  '    DECLARE amount DECIMAL(12,2);',                                    // 6
  '    DECLARE a, b INTEGER 1;',                                          // 7
  '    SET a = amount + 1;',                                              // 8
  '    SET amount = Round2(a, b);',                                       // 9
  '    RETURN TRUE;',                                                     // 10
  '  END;',                                                               // 11
  '',                                                                     // 12
  '  CREATE PROCEDURE CopyHeader()',                                      // 13
  '  BEGIN',                                                              // 14
  '    SET OutputRoot.Properties = InputRoot.Properties;',                // 15
  '  END;',                                                               // 16
  '',                                                                     // 17
  '  CREATE FUNCTION Round2(IN x INTEGER, IN y INTEGER) RETURNS INTEGER', // 18
  '  BEGIN',                                                              // 19
  '    DECLARE scaled INTEGER;',                                          // 20
  '    SET scaled = x + y;',                                              // 21
  '    RETURN scaled;',                                                   // 22
  '  END;',                                                               // 23
  'END MODULE;',                                                          // 24
  '',
].join('\n');

const LINES = SRC.split('\n');
const at = (line: number, word: string, from = 0) => LINES[line].indexOf(word, from);

function format(ranges: Range[]): string[] {
  return ranges.map(
    (r) => `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`
  );
}

let cachedTree: DocAnalysis | undefined;
let treeChecked = false;

/** The parse tree for SRC, or undefined in heuristic mode. */
async function tree(): Promise<DocAnalysis | undefined> {
  if (!treeChecked) {
    treeChecked = true;
    await initGrammar();
    cachedTree = grammarReady() ? analyzeDocument(parse(SRC)!) : undefined;
  }
  return cachedTree;
}

/**
 * Asserts `expected` in heuristic mode (always) and, when the grammar is
 * loaded, in grammar mode too.
 */
async function bothModes(
  label: string,
  run: (doc: DocAnalysis | undefined) => Range[],
  expected: string[]
): Promise<void> {
  assert.deepEqual(format(run(undefined)), expected, `${label} (heuristic)`);
  const doc = await tree();
  if (doc) {
    assert.deepEqual(format(run(doc)), expected, `${label} (grammar)`);
  }
}

test('definition: variable use resolves to its DECLARE', async () => {
  await bothModes('amount', (doc) => definitionAt(SRC, 8, at(8, 'amount', 10), doc), [
    '6:12-6:18',
  ]);
});

test('definition: every name of a multi-name DECLARE resolves', async () => {
  await bothModes('a', (doc) => definitionAt(SRC, 8, at(8, 'a', 8), doc), ['7:12-7:13']);
  await bothModes('b', (doc) => definitionAt(SRC, 9, at(9, 'b', 20), doc), ['7:15-7:16']);
});

test('definition: parameter resolves to the routine header', async () => {
  await bothModes('x', (doc) => definitionAt(SRC, 21, at(21, 'x'), doc), ['18:28-18:29']);
  await bothModes('y', (doc) => definitionAt(SRC, 21, at(21, 'y'), doc), ['18:42-18:43']);
});

test('definition: user routines and CALL targets resolve to CREATE', async () => {
  await bothModes('Round2', (doc) => definitionAt(SRC, 9, at(9, 'Round2'), doc), ['18:18-18:24']);
  await bothModes('CopyHeader', (doc) => definitionAt(SRC, 5, at(5, 'CopyHeader'), doc), [
    '13:19-13:29',
  ]);
  await bothModes('module name', (doc) => definitionAt(SRC, 2, at(2, 'PaymentRouter'), doc), [
    '2:22-2:35',
  ]);
});

test('definition: the declaration itself is a definition site', async () => {
  await bothModes('on the DECLARE', (doc) => definitionAt(SRC, 6, at(6, 'amount', 8), doc), [
    '6:12-6:18',
  ]);
});

test('definition: built-ins and path elements resolve to nothing', async () => {
  await bothModes('InputRoot', (doc) => definitionAt(SRC, 15, at(15, 'InputRoot'), doc), []);
  await bothModes('Properties', (doc) => definitionAt(SRC, 15, at(15, 'Properties'), doc), []);
  const src = SRC + '  SET mystery = 1;\n';
  await bothModes('undeclared name', (doc) => definitionAt(src, 25, 10, doc), []);
});

test('references: uses plus the declaration, in document order', async () => {
  await bothModes('amount', (doc) => referencesAt(SRC, 8, at(8, 'amount', 10), true, doc), [
    '6:12-6:18',
    '8:12-8:18',
    '9:8-9:14',
  ]);
});

test('references: includeDeclaration false drops the declaration', async () => {
  await bothModes('a without its DECLARE', (doc) => referencesAt(SRC, 8, at(8, 'a', 8), false, doc), [
    '8:8-8:9',
    '9:24-9:25',
  ]);
});

test('references: a parameter stays inside its routine', async () => {
  await bothModes('x', (doc) => referencesAt(SRC, 21, at(21, 'x'), true, doc), [
    '18:28-18:29',
    '21:17-21:18',
  ]);
  await bothModes('y', (doc) => referencesAt(SRC, 21, at(21, 'y'), true, doc), [
    '18:42-18:43',
    '21:21-21:22',
  ]);
});

test('references: routine uses include the call sites', async () => {
  await bothModes('Round2', (doc) => referencesAt(SRC, 9, at(9, 'Round2'), true, doc), [
    '9:17-9:23',
    '18:18-18:24',
  ]);
  await bothModes('CopyHeader', (doc) => referencesAt(SRC, 5, at(5, 'CopyHeader'), true, doc), [
    '5:9-5:19',
    '13:19-13:29',
  ]);
});

test('references: module name reports its declaration', async () => {
  await bothModes('PaymentRouter', (doc) => referencesAt(SRC, 2, at(2, 'PaymentRouter'), true, doc), [
    '2:22-2:35',
  ]);
  await bothModes(
    'PaymentRouter without declaration',
    (doc) => referencesAt(SRC, 2, at(2, 'PaymentRouter'), false, doc),
    []
  );
});

test('references: nothing for an undeclared word', async () => {  await bothModes('OutputRoot', (doc) => referencesAt(SRC, 15, at(15, 'OutputRoot'), true, doc), []);
  await bothModes('Data', (doc) => referencesAt('SET OutputRoot.JSON.Data = 1;', 0, 21, true, doc), []);
});

// ── Split routine headers (ISSUES.md I-5) ────────────────────────────────────

/** A header written the way real code writes it: list open on the header line,
 * one parameter per line, RETURNS after the closing paren. */
const SPLIT = [
  'BROKER SCHEMA com.example.policy;', //                                   0
  '', //                                                                   1
  'CREATE COMPUTE MODULE PolicyReader', //                                  2
  '\tCREATE FUNCTION getPolicyProperty(', //                               3
  '\t\tIN policyName CHARACTER,', //                                       4
  '\t\tIN propertyName CHARACTER)', //                                     5
  '\tRETURNS CHARACTER', //                                                 6
  '\tBEGIN', //                                                             7
  '\t\tDECLARE result CHARACTER;', //                                      8
  '\t\tSET result = policyName || propertyName;', //                       9
  '\t\tRETURN result;', //                                                 10
  '\tEND;', //                                                              11
  '', //                                                                   12
  '\tCREATE FUNCTION Main() RETURNS BOOLEAN', //                           13
  '\tBEGIN', //                                                             14
  '\t\tDECLARE host CHARACTER;', //                                        15
  "\t\tSET host = getPolicyProperty('a', 'b');", //                        16
  '\t\tRETURN TRUE;', //                                                   17
  '\tEND;', //                                                              18
  'END MODULE;', //                                                         19
  '',
].join('\n');

const SLINES = SPLIT.split('\n');
const sat = (line: number, word: string, from = 0) => SLINES[line].indexOf(word, from);

let splitTreeChecked = false;
let splitTree: DocAnalysis | undefined;

/** Parse tree for SPLIT, or undefined in heuristic mode. */
async function splitDoc(): Promise<DocAnalysis | undefined> {
  if (!splitTreeChecked) {
    splitTreeChecked = true;
    await initGrammar();
    splitTree = grammarReady() ? analyzeDocument(parse(SPLIT)!) : undefined;
  }
  return splitTree;
}

/** Asserts `expected` on the heuristic path (always) and the grammar path. */
async function bothModesOnSplit(
  label: string,
  run: (doc: DocAnalysis | undefined) => Range[],
  expected: string[]
): Promise<void> {
  assert.deepEqual(format(run(undefined)), expected, `${label} (heuristic)`);
  const doc = await splitDoc();
  if (doc) assert.deepEqual(format(run(doc)), expected, `${label} (grammar)`);
}

test('definition: a parameter of a split header resolves to its own line', async () => {
  await bothModesOnSplit(
    'policyName',
    (doc) => definitionAt(SPLIT, 9, sat(9, 'policyName'), doc),
    ['4:5-4:15']
  );
  await bothModesOnSplit(
    'propertyName',
    (doc) => definitionAt(SPLIT, 9, sat(9, 'propertyName', 20), doc),
    ['5:5-5:17']
  );
});

test('references: a split-header parameter stays inside its routine', async () => {
  await bothModesOnSplit(
    'policyName refs',
    (doc) => referencesAt(SPLIT, 9, sat(9, 'policyName'), true, doc),
    ['4:5-4:15', '9:15-9:25']
  );
  await bothModesOnSplit(
    'propertyName refs',
    (doc) => referencesAt(SPLIT, 9, sat(9, 'propertyName', 20), true, doc),
    ['5:5-5:17', '9:29-9:41']
  );
});

test('definition and references find a routine whose header is split', async () => {
  await bothModesOnSplit(
    'getPolicyProperty def',
    (doc) => definitionAt(SPLIT, 16, sat(16, 'getPolicyProperty'), doc),
    ['3:17-3:34']
  );
  await bothModesOnSplit(
    'getPolicyProperty refs',
    (doc) => referencesAt(SPLIT, 16, sat(16, 'getPolicyProperty'), true, doc),
    ['3:17-3:34', '16:13-16:30']
  );
});

test('the fallback reads parameters and RETURNS from the lines a header spans', () => {
  const routine = routinesFromSource(SPLIT).find((r) => r.name === 'getPolicyProperty')!;
  assert.equal(routine.kind, 'FUNCTION');
  assert.equal(routine.returnType, 'CHARACTER');
  assert.equal(routine.params, 'IN policyName CHARACTER, IN propertyName CHARACTER');

  const params = declarationsFromSource(SPLIT).filter((d) => d.kind === 'parameter');
  assert.deepEqual(
    params.map((p) => `${p.name}@${p.range.start.line}:${p.range.start.character}`),
    ['policyName@4:5', 'propertyName@5:5']
  );
});

// ── Quoted declare names (ISSUES.md I-10) ────────────────────────────────────

test('a quoted EXTERNAL declare declares the name, not the keyword', () => {
  // The grammar rejects this form today (ISSUES.md I-3/H), so only the
  // heuristic path is asserted — but it must not invent a symbol named
  // `EXTERNAL`, which is what the old DECLARE pattern produced in four real
  // files: a name that hovers, navigates and renames, yet is not in the file.
  const src = [
    'DECLARE "script-encoded-hostname" EXTERNAL CHARACTER;', //            0
    '', //                                                                 1
    'CREATE COMPUTE MODULE CorrelId', //                                   2
    '\tCREATE FUNCTION Main() RETURNS BOOLEAN', //                         3
    '\tBEGIN', //                                                          4
    "\t\tSET OutputRoot.JSON.Data.host = \"script-encoded-hostname\";", //  5
    '\t\tRETURN TRUE;', //                                                6
    '\tEND;', //                                                           7
    'END MODULE;', //                                                      8
    '',
  ].join('\n');
  const decls = declarationsFromSource(src);
  assert.deepEqual(
    decls.map((d) => `${d.name}|${d.kind}|${d.detail}`),
    ['script-encoded-hostname|variable|CHARACTER']
  );

  // The symbol is navigable: the cursor on the quoted name resolves to itself
  // and find-references reports the quoted use sites.
  const onName = definitionAt(src, 0, src.indexOf('script-encoded'), undefined);
  assert.deepEqual(
    onName.map((r) => src.slice(r.start.character, r.end.character)),
    ['script-encoded-hostname']
  );
  const useLine = src.split('\n')[5];
  const uses = referencesAt(src, 5, useLine.indexOf('script-encoded'), true, undefined);
  assert.deepEqual(
    uses.map((r) => `${r.start.line}:${r.start.character}`),
    ['0:9', '5:35']
  );

  // A quoted declare in a comment declares nothing: the raw line is only
  // trusted where the masked view agrees the DECLARE is live code.
  const commented = ['-- DECLARE "fake" EXTERNAL CHARACTER;', ''].join('\n');
  assert.deepEqual(declarationsFromSource(commented), []);
});

/**
 * I-15/I-16: the fallback has to know *scopes*, not just names. Hover, completion
 * and go-to-definition all ask these helpers where a name lives, and while the
 * pattern path answered with the whole file as every declaration's scope, a
 * shadowed name hovered the wrong declaration and completion offered variables
 * the cursor could not see.
 */
const SCOPES = [
  'CREATE COMPUTE MODULE Outer', // 0
  '  CREATE FUNCTION First() RETURNS BOOLEAN', // 1
  '  BEGIN', // 2
  '    DECLARE value CHARACTER;', // 3
  '    SET value = 1;', // 4
  '  END;', // 5
  '  CREATE FUNCTION Second() RETURNS INTEGER', // 6
  '  BEGIN', // 7
  '    DECLARE value INTEGER;', // 8
  '    SET value = 3;', // 9
  '  END;', // 10
  'END MODULE;', // 11
  '', // 12
].join('\n');

test('the pattern path puts each declaration in the scope that owns it', async () => {
  const check = (doc: DocAnalysis | undefined) => {
    const declarations = doc ? doc.declaredNames : declarationsFromSource(SCOPES);
    const values = declarations.filter((d) => d.name === 'value');
    assert.equal(values.length, 2, `two declarations of 'value': ${JSON.stringify(declarations.map((d) => [d.name, d.detail]))}`);

    // Each one visible where it is declared, invisible in the other routine.
    assert.equal(rangeContains(values[0].scope, 4, 8), true, "First()'s value covers its own SET");
    assert.equal(rangeContains(values[1].scope, 4, 8), false, "Second()'s value does not");
    assert.equal(rangeContains(values[1].scope, 9, 8), true, "Second()'s value covers its own SET");
    assert.equal(rangeContains(values[0].scope, 9, 8), false, "First()'s value does not");

    // So the helpers agree at one cursor about which declaration it means.
    assert.match(
      declarationAt(declarations, 'value', 4, 8)!.detail,
      /CHARACTER/,
      'line 4 means the CHARACTER declaration'
    );
    assert.match(
      declarationAt(declarations, 'value', 9, 8)!.detail,
      /INTEGER/,
      'line 9 means the INTEGER declaration'
    );

    // Outside every routine (past END MODULE) nothing is visible any more.
    assert.deepEqual(
      visibleDeclarationsAt(declarations, 12, 0).map((d) => d.name),
      [],
      'a position past END MODULE sees no routine-local declarations'
    );

    // And "who owns this line" answers with the routine, which is what hover needs.
    const routines = doc ? doc.routines : routinesFromSource(SCOPES);
    assert.equal(enclosingRoutine(routines, 4, 8)?.name, 'First', 'line 4 belongs to First()');
    assert.equal(enclosingRoutine(routines, 9, 8)?.name, 'Second', 'line 9 belongs to Second()');
    assert.equal(enclosingRoutine(routines, 12, 0), undefined, 'past END MODULE nobody owns the line');
  };
  check(undefined);
  // Same fixture through the tree path, when the addon is there: the two paths
  // disagree about the exact scope edges (body vs whole routine statement), but
  // not about which declaration a cursor sees.
  if (await tree()) check(analyzeDocument(parse(SCOPES)!));
});
