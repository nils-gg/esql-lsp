import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DiagnosticSeverity } from 'vscode-languageserver';
import {
  grammarReady,
  initGrammar,
  parse,
  analyzeDocument,
  semanticTokensForTree,
  SEMANTIC_TOKEN_TYPES,
} from '../src/parser';
import { analyze } from '../src/diagnostics';
import { DEFAULT_SETTINGS } from '../src/settings';
import { skipWithoutGrammar } from './grammarStatus';

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

test('grammar loads and reports ready', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  assert.ok(grammarReady());
});

test('parse tree finds declared names incl. multi-name lists and parameters', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
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

  // Parameters carry their type; a multi-name DECLARE declares every name.
  const param = doc.declaredNames.find((d) => d.name === 'p1')!;
  assert.equal(param.kind, 'parameter');
  assert.match(param.detail, /parameter INT/i);
  assert.deepEqual(
    doc.declaredNames.filter((d) => d.kind === 'variable').map((d) => d.name),
    ['x', 'y']
  );
});

test('declarations carry the scope they are visible in', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const src = [
    'CREATE COMPUTE MODULE M',
    '  DECLARE sharedVar INTEGER;',
    '  CREATE FUNCTION Main(IN seed INTEGER) RETURNS BOOLEAN',
    '  BEGIN',
    '    DECLARE localVar INTEGER;',
    '    RETURN seed;',
    '  END;',
    'END MODULE;',
    '',
  ].join('\n');
  const doc = analyzeDocument(parse(src)!);
  const shared = doc.declaredNames.find((d) => d.name === 'sharedVar')!;
  const local = doc.declaredNames.find((d) => d.name === 'localVar')!;
  const seed = doc.declaredNames.find((d) => d.name === 'seed')!;
  // Module-level DECLARE is visible across the whole module statement
  // (lines 0..7) — so is every routine inside it.
  assert.equal(shared.scope.start.line, 0);
  assert.equal(shared.scope.end.line, 7);
  // Body DECLARE only inside BEGIN..END of Main (lines 3..6).
  assert.equal(local.scope.start.line, 3);
  assert.equal(local.scope.end.line, 6);
  // A parameter is declared in the header but readable in the body.
  assert.equal(seed.kind, 'parameter');
  assert.equal(seed.scope.start.line, 2);
  assert.equal(seed.scope.end.line, 6);
});

test('modules, routines and BROKER SCHEMA are extracted', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const src = [
    'BROKER SCHEMA .mft.Payments;',
    'CREATE FILTER MODULE Router',
    '  CREATE FUNCTION Main() RETURNS BOOLEAN',
    '  BEGIN',
    '    RETURN TRUE;',
    '  END;',
    '  CREATE FUNCTION Helper(IN x INTEGER) RETURNS INTEGER',
    '  BEGIN',
    '    RETURN x;',
    '  END;',
    'END MODULE;',
    '',
  ].join('\n');
  const doc = analyzeDocument(parse(src)!);
  assert.equal(doc.syntaxIssues.length, 0, 'fixture is valid ESQL');

  assert.equal(doc.schemas.length, 1);
  assert.equal(doc.schemas[0].name, 'mft.Payments', 'leading dot stripped');
  assert.equal(doc.schemas[0].range.start.line, 0);

  assert.equal(doc.modules.length, 1);
  assert.equal(doc.modules[0].name, 'Router');
  assert.equal(doc.modules[0].kind, 'FILTER');
  assert.equal(doc.modules[0].range.start.line, 1);
  assert.equal(doc.modules[0].range.end.line, 10);

  assert.deepEqual(doc.routines.map((r) => r.name), ['Main', 'Helper']);
  const helper = doc.routines[1];
  assert.equal(helper.kind, 'FUNCTION');
  assert.equal(helper.params, 'IN x INTEGER');
  assert.equal(helper.returnType, 'INTEGER');
  assert.equal(helper.moduleName, 'Router');
  assert.equal(helper.range.start.line, 6, 'name range for go-to-definition');
  assert.equal(helper.bodyRange!.start.line, 7);
  assert.equal(doc.routines[0].bodyRange!.start.line, 3);
});

test('references distinguish variable uses from routine calls', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const src = [
    'CREATE COMPUTE MODULE M',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  DECLARE total INTEGER;',
    '  DECLARE a INTEGER;',
    '  CALL Helper(a);',
    '  SET total = a + Helper(a);',
    '  SET OutputRoot.JSON.Data.total = a;',
    '  RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const doc = analyzeDocument(parse(src)!);
  const vars = doc.references.filter((r) => r.kind === 'variable');
  const calls = doc.references.filter((r) => r.kind === 'routine');

  assert.deepEqual(
    vars.map((r) => `${r.name}@${r.range.start.line}`),
    ['a@5', 'total@6', 'a@6', 'a@6', 'a@7'],
    'SET targets and call arguments count as uses; the path element ' +
      '"total" in OutputRoot.JSON.Data.total does not'
  );
  assert.deepEqual(
    calls.map((r) => `${r.name}@${r.range.start.line}`),
    ['Helper@5', 'Helper@6'],
    'CALL and function-call syntax both count as routine references'
  );
});

test('schema-qualified CALL keeps the full dotted name', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const src = [
    'CREATE COMPUTE MODULE M',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    '  CALL .mft.Common.Audit(1);',
    '  RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const doc = analyzeDocument(parse(src)!);
  const call = doc.references.find((r) => r.kind === 'routine')!;
  assert.equal(call.name, 'Audit');
  assert.equal(call.qualified, 'mft.Common.Audit');
});

test('handler DECLAREs contribute no declared names', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
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

test('bare SET targets are collected; message-tree paths are not', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const tree = parse(FULL)!;
  const doc = analyzeDocument(tree);
  assert.deepEqual(doc.setTargets.map((t2) => t2.name), ['b', 'c']);
});

test('semantics are mined from intact subtrees inside error regions', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
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
  assert.deepEqual(doc.setTargets.map((t2) => t2.name), ['myVar']);
});

test('a module whose END MODULE is missing is still identified', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // The commonest broken file: still typing the end of the module. Recovery
  // swallows the header into an ERROR region, so the module has to be read
  // back out of the surviving tokens.
  const src = [
    'CREATE COMPUTE MODULE Unclosed',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'RETURN TRUE;',
    'END;',
    '',
  ].join('\n');
  const doc = analyzeDocument(parse(src)!);
  assert.equal(doc.modules.length, 1, 'module recovered from the error region');
  assert.equal(doc.modules[0].name, 'Unclosed');
  assert.equal(doc.modules[0].kind, 'COMPUTE');
  assert.equal(doc.modules[0].nameRange.start.line, 0);
  assert.equal(doc.routines.length, 1);
  assert.equal(doc.routines[0].name, 'Main');
  assert.equal(doc.routines[0].moduleName, 'Unclosed', 'routine knows its module');
});

test('recovered missing tokens (invisible insertions) are reported', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // Tree-sitter repairs a missing `;` between otherwise clean statements
  // by inserting a zero-width token node — no ERROR region anywhere.
  const src = [
    'CREATE COMPUTE MODULE M',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'DECLARE x INT 0',
    'SET x = 1;',
    'RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const tree = parse(src)!;
  const doc = analyzeDocument(tree);
  assert.equal(doc.syntaxIssues.length, 1, 'exactly the missing ";"');
  assert.match(doc.syntaxIssues[0].message, /Missing syntax: expected ';'/);
  assert.equal(doc.syntaxIssues[0].range.start.line, 3);
});

test('a recovered token is described by the construct that needed it', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // The binding reports an inserted token by its grammar token name, and at a
  // choice point it names whichever alternative the DFA reached first. So this
  // real namespace declaration was reported as "expected 'kw_BIT' here", which is
  // not merely ugly but a false statement about ESQL (ISSUES.md I-12).
  const doc = analyzeDocument(parse("DECLARE ns NAMESPACE 'urn:x';\n")!);
  assert.equal(doc.syntaxIssues.length, 1);
  assert.match(doc.syntaxIssues[0].message, /expected a data type here/);
  assert.doesNotMatch(doc.syntaxIssues[0].message, /kw_|identifier|_literal/);

  // Same for the other corpus leak, `SET OutputRoot.[<+1] = InputBody;` — in
  // context only, so the case is shaped like the file that reported it.
  const field = analyzeDocument(
    parse(
      [
        'CREATE COMPUTE MODULE M',
        '\tCREATE FUNCTION Main() RETURNS BOOLEAN',
        '\tBEGIN',
        '\t\tSET OutputRoot.[<+1] = InputBody;',
        '\t\tRETURN TRUE;',
        '\tEND;',
        'END MODULE;',
        '',
      ].join('\n')
    )!
  );
  assert.ok(
    field.syntaxIssues.some((i) => /expected a field reference here/.test(i.message)),
    JSON.stringify(field.syntaxIssues.map((i) => i.message))
  );
});

test('syntax errors are detected from ERROR/MISSING nodes', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
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

test('analyze() with a tree: exact undeclared range, no semicolon hint', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
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

test('syntax error diagnostics are Errors and gated by checkSyntaxErrors', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
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

test('semantic tokens encode as LSP relative quintuples', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const source = "DECLARE x INT 1;\n-- a comment\nSET x = 'text';\n";
  const tree = parse(source)!;
  const data = semanticTokensForTree(tree, source)!;
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

// Regression tests for the round-2 findings about line endings and ranges
// (ISSUES.md I-18 / I-19): the same text has to mean the same thing to the
// client, to the scanner and to tree-sitter, whether it ends its lines with LF,
// CRLF or a lone CR. A client counts all three as one line break; tree-sitter
// counts only LF, so `parse()` bridges that gap — and every range the server
// reports has to stay inside the line the client has at that row.

const EOL_LINES = [
  'CREATE COMPUTE MODULE Endings', // 0
  'CREATE FUNCTION Main() RETURNS BOOLEAN', // 1
  'BEGIN', // 2
  '-- a comment', // 3
  'DECLARE y INT;', // 4
  'SET y = 7;', // 5
  'RETURN TRUE;', // 6
  'END;', // 7
  'END MODULE;', // 8
  '', // 9
];
const LF_TEXT = EOL_LINES.join('\n');
const CRLF_TEXT = EOL_LINES.join('\r\n');
const CR_TEXT = EOL_LINES.join('\r');
const ALL_ENDINGS: Array<[string, string]> = [
  ['LF', LF_TEXT],
  ['CRLF', CRLF_TEXT],
  ['lone CR', CR_TEXT],
];

test('a lone CR ends a line for the server, as it does for the client', async (t) => {
  // The scanner half runs in heuristic mode too: it is what hover and the
  // pattern-based diagnostics index by.
  const { lines } = (await import('../src/scanner')).scan(CR_TEXT);
  assert.equal(lines.length, EOL_LINES.length, 'the scanner counts a lone CR as a line break');
  const { hoverAt } = await import('../src/hover');
  assert.match(
    (hoverAt(CR_TEXT, 4, 9)?.contents as { value?: string } | undefined)?.value ?? '',
    /`y`/,
    'hover describes the DECLARE the client sees on line 4'
  );

  if (!(await skipWithoutGrammar(t))) return;
  for (const [name, text] of ALL_ENDINGS) {
    const doc = analyzeDocument(parse(text)!);
    assert.deepEqual(doc.syntaxIssues.map((i) => i.message), [], `${name}: line endings are not damage`);
    assert.equal(
      doc.declaredNames.find((d) => d.name === 'y')?.range.start.line,
      4,
      `${name}: DECLARE y is reported on client line 4`
    );
    assert.equal(
      doc.setTargets.find((s) => s.name === 'y')?.range.start.line,
      5,
      `${name}: SET y is reported on client line 5`
    );
  }
});

test('every semantic token ends on the line it starts on', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // I-18: a comment token reached one column past its line on CRLF files, so the
  // client painted the following line in comment colour. The encoder clamps each
  // token to the length the client has for that line, whatever the grammar matched.
  for (const [name, text] of ALL_ENDINGS) {
    const data = semanticTokensForTree(parse(text)!, text)!;
    const textLines = (await import('../src/scanner')).linesOf(text);
    assert.ok(data.length >= 5 * 10, `${name}: several tokens encoded`);
    let line = 0;
    for (let i = 0; i < data.length; i += 5) {
      line += data[i];
      const [startLine, startChar, length] = [line, data[i + 1], data[i + 2]];
      assert.ok(startChar >= 0 && length > 0, `${name}: token ${i / 5} has a sane start`);
      assert.ok(
        startChar + length <= textLines[startLine].length,
        `${name}: token ${i / 5} (line ${startLine}, col ${startChar}, len ${length}) stays inside ` +
          `the ${textLines[startLine].length}-column line the client has there`
      );
    }
  }
});

test('no symbol or diagnostic range reaches past the end of its line', async () => {
  // I-18, both modes: a range that runs past end-of-line makes the client mark
  // up text it was never about, and `Range#create` complains about the shape.
  const { analyze } = await import('../src/diagnostics');
  const { DEFAULT_SETTINGS } = await import('../src/settings');
  const { documentSymbols, documentSymbolsFromTree } = await import('../src/symbols');
  const { declarationsFromSource } = await import('../src/definitions');
  for (const [name, text] of ALL_ENDINGS) {
    const lines = (await import('../src/scanner')).linesOf(text);
    const check = (label: string, ranges: { start: { line: number; character: number }; end: { line: number; character: number } }[]) => {
      for (const r of ranges) {
        assert.ok(r.end.line < lines.length, `${name}: ${label} range ${JSON.stringify(r)} is inside the document`);
        assert.ok(
          r.end.character <= lines[r.end.line].length,
          `${name}: ${label} range ${JSON.stringify(r)} does not reach past line ${r.end.line} ` +
            `(${lines[r.end.line].length} columns)`
        );
      }
    };
    check('fallback declarations', declarationsFromSource(text).map((d) => d.range));
    check(
      'fallback symbols',
      documentSymbols(text).flatMap((s) => [
        s.selectionRange,
        s.range,
        ...(s.children ?? []).map((c) => c.selectionRange),
      ])
    );
    check('fallback diagnostics', analyze(text, DEFAULT_SETTINGS.diagnostics).map((d) => d.range));

    // The tree path, when this machine has the addon: same promise.
    if (await initGrammar()) {
      const doc = analyzeDocument(parse(text)!);
      check('tree declarations', doc.declaredNames.map((d) => d.range));
      check('tree SET targets', doc.setTargets.map((t2) => t2.range));
      check('tree syntax issues', doc.syntaxIssues.map((i) => i.range));
      check(
        'tree symbols',
        documentSymbolsFromTree(doc).flatMap((s) => [s.selectionRange, s.range])
      );
    }
  }
});
