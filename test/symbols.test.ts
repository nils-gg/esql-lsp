/**
 * Document symbols — pattern fallback and parse-tree paths.
 *
 * SAMPLE keeps a module-level `BEGIN` that the grammar (following the IBM
 * railroad diagram) does not accept: the pattern fallback is deliberately
 * forgiving about that, so it stays a fallback test only. VALID_SAMPLE is
 * grammar-clean and is what the two paths are compared on.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SymbolKind } from 'vscode-languageserver';
import { documentSymbols, documentSymbolsFromTree } from '../src/symbols';
import { initGrammar, parse, analyzeDocument, grammarReady } from '../src/parser';

const SAMPLE = [
  "BROKER SCHEMA com.example.flow;",
  "",
  "CREATE COMPUTE MODULE OrderProcessing",
  "BEGIN",
  "DECLARE orderRef REFERENCE InputRoot.JSON.Data;",
  "DECLARE orderNumber INTEGER;",
  "",
  "CREATE PROCEDURE ValidateOrder(IN orderId INTEGER)",
  "BEGIN",
  "DECLARE isValid BOOLEAN;",
  "SET isValid = TRUE;",
  "END;",
  "",
  "CREATE FUNCTION Main() RETURNS BOOLEAN",
  "BEGIN",
  "SET OutputRoot.Properties = InputRoot.Properties;",
  "PROPAGATE TO TERMINAL 'out';",
  "RETURN TRUE;",
  "END;",
  "END MODULE;",
  "",
].join('\n');

const VALID_SAMPLE = [
  'BROKER SCHEMA com.example.flow;',                         // 0
  '',                                                        // 1
  'CREATE COMPUTE MODULE OrderProcessing',                   // 2
  'DECLARE orderRef REFERENCE InputRoot.JSON.Data;',         // 3
  'DECLARE a, b, c INTEGER 1;',                              // 4
  '',                                                        // 5
  'CREATE PROCEDURE ValidateOrder(IN orderId INTEGER)',      // 6
  'BEGIN',                                                   // 7
  'DECLARE isValid BOOLEAN;',                                // 8
  'SET isValid = TRUE;',                                     // 9
  'END;',                                                    // 10
  '',                                                        // 11
  'CREATE FUNCTION Main() RETURNS BOOLEAN',                  // 12
  'BEGIN',                                                   // 13
  'SET orderRef = InputRoot.JSON.Data;',                     // 14
  "PROPAGATE TO TERMINAL 'out';",                            // 15
  'END;',                                                    // 16
  'END MODULE;',                                             // 17
  '',
].join('\n');

/** `kind:name [detail]` lines with two spaces of indent per nesting level. */
function outline(symbols: ReturnType<typeof documentSymbols>, depth = 0): string[] {
  const out: string[] = [];
  for (const s of symbols) {
    out.push(`${'  '.repeat(depth)}${s.kind}:${s.name}${s.detail ? ` [${s.detail}]` : ''}`);
    if (s.children) out.push(...outline(s.children, depth + 1));
  }
  return out;
}

/** Tree outline for source, or null in heuristic mode (no addon). */
async function treeOutline(source: string): Promise<string[] | null> {
  await initGrammar();
  if (!grammarReady()) return null;
  const tree = parse(source);
  if (!tree) return null;
  return outline(documentSymbolsFromTree(analyzeDocument(tree)));
}

test('extracts namespace, module, functions and variables', () => {
  const syms = documentSymbols(SAMPLE);

  const ns = syms.find((s) => s.kind === SymbolKind.Namespace);
  assert.ok(ns, 'namespace found');
  assert.equal(ns!.name, 'com.example.flow');

  const mod = syms.find((s) => s.kind === SymbolKind.Module);
  assert.ok(mod, 'module found');
  assert.equal(mod!.name, 'OrderProcessing');
  assert.equal(mod!.detail, 'COMPUTE MODULE');

  // Module spans from CREATE COMPUTE MODULE to END MODULE.
  assert.equal(mod!.range.start.line, 2);
  assert.equal(mod!.range.end.line, 19);

  const children = mod!.children ?? [];
  const fnNames = children.filter((c) => c.kind === SymbolKind.Function).map((c) => c.name);
  assert.deepEqual(fnNames, ['ValidateOrder', 'Main']);
  // Only the module-level DECLAREs sit directly under the module: routine
  // parameters and body DECLAREs belong to their routine (see below).
  const varNames = children.filter((c) => c.kind === SymbolKind.Variable).map((c) => c.name);
  assert.deepEqual(varNames, ['orderRef', 'orderNumber']);

  // Function detail includes params.
  const validate = children.find((c) => c.name === 'ValidateOrder')!;
  assert.equal(validate.detail, 'PROCEDURE(IN orderId INTEGER)');
  assert.equal(validate.kind, SymbolKind.Function);

  // ValidateOrder body spans CREATE PROCEDURE (line 7) .. END; (line 11)
  assert.equal(validate.range.start.line, 7);
  assert.equal(validate.range.end.line, 11);

  // Its own symbols — the parameter and the DECLARE inside its body.
  assert.deepEqual(outline(validate.children ?? [], 0), [
    '13:orderId [parameter INTEGER]',
    '13:isValid [BOOLEAN]',
  ]);

  // Main body spans CREATE FUNCTION (line 13) .. END; (line 18)
  const main = children.find((c) => c.name === 'Main')!;
  assert.equal(main.range.start.line, 13);
  assert.equal(main.range.end.line, 18);
  assert.equal(main.detail, 'FUNCTION() RETURNS BOOLEAN');

  // Variable detail includes type.
  const orderRef = children.find((c) => c.name === 'orderRef')!;
  assert.equal(orderRef.detail, 'REFERENCE');
});

test('every name of a multi-name DECLARE becomes a symbol', () => {
  const outlineFor = outline(documentSymbols(VALID_SAMPLE));
  assert.deepEqual(
    outlineFor.filter((l) => /:(a|b|c) \[INTEGER\]/.test(l)),
    ['  13:a [INTEGER]', '  13:b [INTEGER]', '  13:c [INTEGER]'],
    'one DECLARE declares all three names'
  );
});

test('the parse tree and the pattern fallback agree on the outline', async () => {
  const fromTree = await treeOutline(VALID_SAMPLE);
  if (!fromTree) return; // heuristic-only environment: nothing to compare
  assert.deepEqual(fromTree, outline(documentSymbols(VALID_SAMPLE)));
});

test('the parse tree nests routines and declarations inside the module', async () => {
  const fromTree = await treeOutline(VALID_SAMPLE);
  if (!fromTree) return;
  assert.deepEqual(fromTree, [
    '3:com.example.flow [BROKER SCHEMA]',
    '2:OrderProcessing [COMPUTE MODULE]',
    '  13:orderRef [REFERENCE]',
    '  13:a [INTEGER]',
    '  13:b [INTEGER]',
    '  13:c [INTEGER]',
    '  12:ValidateOrder [PROCEDURE(IN orderId INTEGER)]',
    '    13:orderId [parameter INTEGER]',
    '    13:isValid [BOOLEAN]',
    '  12:Main [FUNCTION() RETURNS BOOLEAN]',
  ]);
});

test('a module-level DECLARE is visible to (and nested in) the module only', async () => {
  const fromTree = await treeOutline(VALID_SAMPLE);
  if (!fromTree) return;
  // orderRef/a/b/c are declared in the module, not inside a routine, so they
  // must not be nested under Main even though Main uses them.
  const tree = parse(VALID_SAMPLE)!;
  const doc = analyzeDocument(tree);
  const orderRef = doc.declaredNames.find((d) => d.name === 'orderRef')!;
  assert.equal(orderRef.scope.start.line, 2, 'visible from the module header');
  assert.equal(orderRef.scope.end.line, 17, 'to END MODULE');
});

test('an unclosed module still owns the routines below it', async () => {
  const src = [
    'CREATE COMPUTE MODULE Unclosed',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'RETURN TRUE;',
    'END;',
    '',
  ].join('\n');
  const mod = documentSymbols(src).find((s) => s.kind === SymbolKind.Module)!;
  assert.ok(
    (mod.children ?? []).some((c) => c.name === 'Main'),
    'the fallback nests routines of a module with no END MODULE'
  );
  const fromTree = await treeOutline(src);
  if (fromTree) {
    assert.ok(
      fromTree.some((l) => /^\s+12:Main\b/.test(l)),
      `the parse tree nests it too: ${JSON.stringify(fromTree)}`
    );
  }
});

test('nested BEGIN blocks (handlers) do not close the function early', () => {
  const src = [
    'CREATE COMPUTE MODULE M',
    'BEGIN',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    "DECLARE CONTINUE HANDLER FOR SQLSTATE LIKE '%'",
    'BEGIN',
    'SET OutputRoot.Properties = InputRoot.Properties;',
    'END;',
    "PROPAGATE TO TERMINAL 'out';",
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const syms = documentSymbols(src);
  const mod = syms.find((s) => s.kind === SymbolKind.Module)!;
  const main = (mod.children ?? []).find((c) => c.name === 'Main')!;
  assert.equal(main.range.start.line, 2);
  assert.equal(main.range.end.line, 9);
});

test('a fake END MODULE inside a string does not truncate the module range', () => {
  const src = [
    'CREATE COMPUTE MODULE M',
    'BEGIN',
    "CREATE FUNCTION Main() RETURNS BOOLEAN",
    'BEGIN',
    "SET x = 'END MODULE';",
    "PROPAGATE TO TERMINAL 'out';",
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const syms = documentSymbols(src);
  const mod = syms.find((s) => s.kind === SymbolKind.Module)!;
  assert.equal(mod.range.end.line, 7);
});

test('empty source yields no symbols', () => {
  assert.deepEqual(documentSymbols(''), []);
});
