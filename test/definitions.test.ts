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
import { definitionAt, referencesAt } from '../src/definitions';

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

test('references: nothing for an undeclared word', async () => {
  await bothModes('OutputRoot', (doc) => referencesAt(SRC, 15, at(15, 'OutputRoot'), true, doc), []);
  await bothModes('Data', (doc) => referencesAt('SET OutputRoot.JSON.Data = 1;', 0, 21, true, doc), []);
});
