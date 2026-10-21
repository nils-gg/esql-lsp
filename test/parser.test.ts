import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DiagnosticSeverity } from 'vscode-languageserver';
import {
  initGrammar,
  grammarReady,
  parse,
  analyzeDocument,
  semanticTokensForTree,
  SEMANTIC_TOKEN_TYPES,
} from '../src/parser';
import { analyze } from '../src/diagnostics';
import { DEFAULT_SETTINGS } from '../src/settings';

const FULL = [
  'BROKER SCHEMA .mft.S;',
  'CREATE COMPUTE MODULE G',
  'CREATE FUNCTION Main() RETURNS BOOLEAN',
  'BEGIN',
  '  DECLARE a, b INT 1;',
  "  DECLARE sp CHARACTER NAMESPACE 'http://x';",
  '  SET b = a + 1;',
  '  SET c = 2;',
  '  SET OutputRoot.Data.X = 1;',
  '  RETURN TRUE;',
  'END',
  'END MODULE;',
  '',
].join('\n');

test('grammar loads and reports ready', async () => {
  assert.equal(await initGrammar(), true);
  assert.ok(grammarReady());
});

test('parse tree finds declared names incl. multi-name lists and parameters', async () => {
  await initGrammar();
  const tree = parse([
    'CREATE COMPUTE MODULE M',
    'CREATE FUNCTION F(IN p1 INT) RETURNS BOOLEAN',
    'BEGIN',
    '  DECLARE x, y INT 1;',
    '  RETURN p1;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n'))!;
  assert.ok(tree);
  const doc = analyzeDocument(tree);
  const names = doc.declaredNames.map((d) => d.name);
  assert.ok(names.includes('x'), 'x declared');
  assert.ok(names.includes('y'), 'second name of multi-name declare');
  assert.ok(names.includes('p1'), 'parameter declared');
});

test('handler DECLAREs contribute no declared names', async () => {
  await initGrammar();
  const tree = parse([
    'CREATE COMPUTE MODULE M',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    "  DECLARE CONTINUE HANDLER FOR SQLSTATE '05001'",
    '  SET Environment.N = 1;',
    '  RETURN TRUE;',
    'END',
    'END MODULE;',
    '',
  ].join('\n'))!;
  const doc = analyzeDocument(tree);
  assert.deepEqual(doc.declaredNames, []);
});

test('bare SET targets are collected; message-tree paths are not', async () => {
  await initGrammar();
  const tree = parse(FULL)!;
  const doc = analyzeDocument(tree);
  assert.deepEqual(doc.setTargets.map((t) => t.name), ['b', 'c']);
});

test('semantics are mined from intact subtrees inside error regions', async () => {
  await initGrammar();
  // Module never closed -> whole module statement becomes one ERROR
  // region, but tree-sitter recovery keeps the routine subtree intact.
  const src = [
    'CREATE COMPUTE MODULE M',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    "  SET myVar = 'hello';",
    '  RETURN TRUE;',
    'END;',
    '',
  ].join('\n');
  const tree = parse(src)!;
  const doc = analyzeDocument(tree);
  assert.ok(doc.syntaxIssues.length > 0, 'still reports the syntax error');
  assert.deepEqual(doc.setTargets.map((t) => t.name), ['myVar']);
});

test('syntax errors are detected from ERROR/MISSING nodes', async () => {
  await initGrammar();
  const tree = parse('CREATE COMPUTE MODULE M\nSET x = (1;\n')!;
  const doc = analyzeDocument(tree);
  assert.ok(doc.syntaxIssues.length > 0, 'at least one syntax issue');
  // Outermost-only: issues must not nest inside each other.
  for (const a of doc.syntaxIssues) {
    for (const b of doc.syntaxIssues) {
      if (a === b) continue;
      const nested =
        a.range.start.line >= b.range.start.line &&
        a.range.end.line <= b.range.end.line &&
        a.range.start.character >= b.range.start.character &&
        a.range.end.character <= b.range.end.character;
      assert.ok(!nested, 'error regions must not nest');
    }
  }
});

test('analyze() with a tree: exact undeclared range, no semicolon hint', async () => {
  await initGrammar();
  const tree = parse(FULL)!;
  const doc = analyzeDocument(tree);
  assert.equal(doc.syntaxIssues.length, 0, 'FULL is valid ESQL');

  const diags = analyze(FULL, DEFAULT_SETTINGS.diagnostics, doc);
  const undeclared = diags.filter((d) => /never declared/.test(d.message));
  assert.equal(undeclared.length, 1);
  assert.match(undeclared[0].message, /Variable 'c'/);
  // Exact range: line 7 (`  SET c = 2;`), column of `c`.
  assert.equal(undeclared[0].range.start.line, 7);
  assert.equal(undeclared[0].range.start.character, 6);

  // The grammar reports real missing semicolons as errors; the hint path
  // must stay silent when a tree is present.
  assert.ok(diags.every((d) => !/missing semicolon/.test(d.message)));
});

test('syntax error diagnostics are Errors and gated by checkSyntaxErrors', async () => {
  await initGrammar();
  const src = 'CREATE COMPUTE MODULE M\nSET x = (1;\n';
  const tree = parse(src)!;
  const doc = analyzeDocument(tree);
  const diags = analyze(src, DEFAULT_SETTINGS.diagnostics, doc);
  assert.ok(diags.some((d) => d.severity === DiagnosticSeverity.Error));

  const gated = analyze(
    src,
    { ...DEFAULT_SETTINGS.diagnostics, checkSyntaxErrors: false },
    doc
  );
  assert.ok(gated.every((d) => !/Syntax error|Missing syntax/.test(d.message)));
});

test('semantic tokens encode as LSP relative quintuples', async () => {
  await initGrammar();
  const tree = parse("DECLARE x INT 1;\n-- a comment\nSET x = 'text';\n")!;
  const data = semanticTokensForTree(tree)!;
  assert.ok(Array.isArray(data));
  assert.equal(data.length % 5, 0);
  assert.ok(data.length >= 5 * 5, 'several tokens encoded');

  // First token on line 0: DECLARE -> keyword.
  assert.equal(data[0], 0, 'deltaLine');
  assert.equal(data[1], 0, 'deltaStartChar');
  assert.equal(data[2], 'DECLARE'.length, 'length');
  assert.equal(data[3], SEMANTIC_TOKEN_TYPES.indexOf('keyword'), 'keyword type');
  assert.equal(data[4], 0, 'modifiers');

  // All type indices are inside the advertised legend.
  for (let i = 3; i < data.length; i += 5) {
    assert.ok(data[i] >= 0 && data[i] < SEMANTIC_TOKEN_TYPES.length);
  }
});
