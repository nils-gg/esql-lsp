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
  // Tree-sitter repairs a missing `;` by inserting a zero-width token node —
  // but only when the next token cannot possibly continue the expression:
  // `END` cannot, so the repair is an insertion with no ERROR region.
  // (A previous version of this fixture used `DECLARE x INT 0` followed by
  // `SET x = 1;` and asserted the insertion message — that passed against a
  // STALE node_modules grammar copy, never against the real parser: with
  // the parser the server actually loads, recovery pastes `SET x` into the
  // declaration instead — the seam shape the E-8 test above owns. The
  // grammar-copy trap from AGENTS.md, applied to test greenness.)
  const src = [
    'CREATE COMPUTE MODULE M',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'SET x = 1',
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
  // The namespace-prefix DECLARE used to be the poster child for this
  // problem: rejected and "helpfully" explained as "expected kw_BIT here",
  // a false statement about ESQL (families A + I-12). The 12.0.x DECLARE
  // page documents `DECLARE prefixOne NAMESPACE '…';` verbatim, so the
  // grammar now accepts it and NOTHING may be reported — and the alias is
  // a path prefix, not a variable, so it must not be indexed either.
  const ns = analyzeDocument(parse("DECLARE ns NAMESPACE 'urn:x';\n")!);
  assert.deepEqual(ns.syntaxIssues, [], 'the documented alias form parses clean');
  assert.deepEqual(
    ns.declaredNames.map((d) => d.name),
    [],
    'the namespace alias is not indexed as a declared variable (family A)'
  );

  // The other corpus leak, `SET OutputRoot.[<+1] = InputBody;`, IS still an
  // error: IBM's `[<n]` index counts from the end and no documented form
  // means what the sample intended (family J verdict: NOT-ESQL, recorded
  // in VERIFICATION.md). In context only, shaped like the file that
  // reported it.
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

// ISSUES.md I-12: a bare `Syntax error.` spanning multiple lines from the
// middle of a statement is not actionable. Damage now gets named after the
// construct it sits in and clamped to that construct's first line — with the
// precise-range bare message kept for regions nothing can honestly name.
const i12wrap = (...body: string[]) =>
  ['CREATE COMPUTE MODULE M', 'CREATE FUNCTION Main() RETURNS BOOLEAN', 'BEGIN', ...body, 'END', 'END MODULE;'].join('\n');

test('a statement that swallowed the next names the missing terminator (I-12, E-8)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // `;` missing after a DECLARE with an initial value: recovery pastes
  // `SET x` into the declaration. I-12 called that "a DECLARE statement"
  // error; CODE_REVIEW.md E-8 adjudicated the phrasing as saying LESS than
  // the heuristic Hint it replaced — the damage is the seam BETWEEN two
  // statements, so the message names the `;` and the range is the slot it
  // belongs in. (E-2's file-wide cascade is the same root cause, bigger.)
  const src = i12wrap('DECLARE x INT 0', 'SET x = 1;', 'RETURN TRUE;');
  const doc = analyzeDocument(parse(src)!, src);
  assert.equal(doc.syntaxIssues.length, 1, JSON.stringify(doc.syntaxIssues));
  const issue = doc.syntaxIssues[0];
  assert.equal(issue.message, "Statement is not terminated — expected ';' here.");
  assert.equal(issue.range.start.line, 3, 'at the end of the unterminated line...');
  assert.equal(issue.range.start.character, 15, '...right past the final token...');
  assert.equal(issue.range.end.line, 4, '...through the gap the `;` belongs in');

  // The review's live variant one statement shape further down: the same
  // message for `SET done = TRUE` followed by `RETURN TRUE;`.
  const src2 = i12wrap('SET done = TRUE', 'RETURN TRUE;');
  const ret = analyzeDocument(parse(src2)!, src2);
  assert.equal(ret.syntaxIssues.length, 1);
  assert.equal(ret.syntaxIssues[0].message, "Statement is not terminated — expected ';' here.");
  assert.equal(ret.syntaxIssues[0].range.start.line, 3);
  assert.equal(ret.syntaxIssues[0].range.end.line, 4);
});

test('damage opening an expression slot mid-statement still names the statement (I-12)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // The named-phrase path the seam reading must NOT eat: the region opens
  // with a number (no statement keyword), the surviving set_statement names
  // it, and the range clamps to the statement's first line.
  const src = i12wrap('SET x = 1 2;', 'RETURN TRUE;');
  const doc = analyzeDocument(parse(src)!, src);
  const named = doc.syntaxIssues.find((i) => /^Syntax error in a SET statement\.$/.test(i.message));
  assert.ok(named, JSON.stringify(doc.syntaxIssues.map((i) => i.message)));
  assert.equal(named!.range.start.line, 3, 'the SET line');
  assert.equal(named!.range.end.line, 3, 'a single line');
});

test('a statement that never formed is named from its own keyword (I-12)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // `IF x = THEN`: no if_statement node survives, the region is raw tokens —
  // and its leading keyword still says what the author was writing.
  const src = i12wrap('IF x = THEN', '  SET y = 1;', 'RETURN TRUE;');
  const doc = analyzeDocument(parse(src)!, src);
  const named = doc.syntaxIssues.find((i) => /IF statement/.test(i.message));
  assert.ok(named, JSON.stringify(doc.syntaxIssues.map((i) => i.message)));
  // Exact: the region opens with the real keyword IF, so no did-you-mean
  // suffix may decorate a correctly spelled (merely misplaced) word.
  assert.equal(named!.message, 'Syntax error in an IF statement.');
  assert.equal(named!.range.start.line, 3, 'at the IF itself, not some enclosing header');
  assert.equal(named!.range.end.line, 3);
});

test('the message builder never goes silent: garbage gets its token quoted (I-12, E-1)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const src = i12wrap('%%% ***', 'RETURN TRUE;');
  const doc = analyzeDocument(parse(src)!, src);
  assert.ok(doc.syntaxIssues.length >= 1);
  // E-1 adjudicated the bare fallthrough: the found token is always quoted
  // when the region has one, so the reader never diffs a squiggle against
  // the grammar by hand. (Only a region of pure comment damage — no token
  // at all — may still print the bare text, and this is not one.)
  const quoted = doc.syntaxIssues.find((i) => /^Unexpected '.*' here\.$/.test(i.message));
  assert.ok(quoted, JSON.stringify(doc.syntaxIssues.map((i) => i.message)));
  assert.equal(quoted!.message, "Unexpected '%%%' here.", 'the region opens with %%%');
  assert.equal(quoted!.range.start.line, 3, 'at the garbage, not at a named construct');
  assert.ok(
    !doc.syntaxIssues.some((i) => i.message === 'Syntax error.'),
    'no bare message survives this fixture'
  );
});

// ── E-1/E-8/E-10 message corpus: the review's live cases, as tested surface ──

/** The issues a body snippet produces inside the standard module wrapper. */
const messagesFor = (...body: string[]) => {
  const src = i12wrap(...body);
  return analyzeDocument(parse(src)!, src).syntaxIssues;
};

test('the found token is quoted and a near-keyword is suggested (E-1)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // The review's headline reproduction: `SETN broken = 1;` answered bare
  // `Syntax error.` The transposition distance to SET is right there —
  // the message says it now.
  const issues = messagesFor('SETN broken = 1;', 'RETURN TRUE;');
  assert.equal(issues.length, 1, JSON.stringify(issues.map((i) => i.message)));
  assert.equal(issues[0].message, "Unexpected 'SETN' here. Did you mean 'SET'?");
  assert.equal(issues[0].range.start.line, 3, 'at the typo itself');
});

test('an inserted closing paren names its unclosed opener (E-10)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // Three surfaces of one shape — CALL parens, grouping parens, CAST parens.
  // The grammar repairs all three by INSERTING `)`, and the message now
  // points at the `(` the reader must close instead of making them count.
  // Line numbers in the message are 1-based human counting (the body sits
  // on 0-based row 3): ranges elsewhere in the issue stay 0-based LSP.
  const expected = "Missing syntax: expected ')' here — this '(' on line 4 is unclosed.";
  for (const line of ['SET x = COALESCE(1, 2;', 'SET x = (1;', 'SET x = CAST(1 AS INTEGER + 2;']) {
    assert.deepEqual(
      messagesFor(line, 'RETURN TRUE;').map((i) => i.message),
      [expected],
      line
    );
  }
});

// ── E-2: a top-level forgotten `;` and everything it takes down ────────────

/**
 * The review's live reproduction: a module-level DECLARE missing its `;`
 * makes error recovery swallow the CREATE MODULE header, the routine and
 * the body into one ERROR spanning the file — before E-2 the analysis
 * returned one file-wide `Syntax error.` with declaredNames and routines
 * effectively empty, degrading completion, go-to-definition and the
 * undeclared check at once.
 */
const E2_CASCADE = [
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

test('a forgotten `;` above a module names the cascade it starts (E-2a)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const doc = analyzeDocument(parse(E2_CASCADE)!, E2_CASCADE);
  const first = doc.syntaxIssues[0];
  // Same seam reading as E-8's single swallowed statement — but the region
  // holds more than one statement opener, so the message says WHICH
  // statement lost its terminator and what ran over it. (The plain
  // `Statement is not terminated — expected ';' here.` for one swallowed
  // statement is the E-8 corpus' surface; both phrasings must stay distinct.)
  assert.equal(
    first.message,
    "This DECLARE statement is not terminated — expected ';' before 'CREATE'."
  );
  // Anchored in the slot the `;` belongs in: right after `INTEGER` on the
  // DECLARE line, through the whitespace the terminator should occupy.
  assert.equal(first.range.start.line, 2);
  assert.equal(first.range.start.character, 35);
  assert.deepEqual([first.range.end.line, first.range.end.character], [4, 0]);
});

test('names, routines and SET targets inside the cascade survive (E-2b)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const doc = analyzeDocument(parse(E2_CASCADE)!, E2_CASCADE);
  // Before the mining pass this analysis saw ONE declared name (the tree's
  // own children stop at the region), no routines at all, and every SET
  // target below the swallowed header went missing.
  assert.deepEqual(
    doc.declaredNames.map((d) => d.name).sort(),
    ['FailureCount', 'local']
  );
  assert.equal(
    doc.declaredNames.filter((d) => d.name === 'FailureCount').length,
    1,
    'tree entries come first: the padding re-read must not duplicate them'
  );
  const local = doc.declaredNames.find((d) => d.name === 'local')!;
  assert.ok(local, 'mined out of the region text');
  assert.deepEqual([local.range.start.line, local.range.start.character], [8, 12], 'file coordinates');
  assert.equal(local.detail, 'INTEGER', 'line-padded slice: the cut-off datatype still reads');
  assert.ok(local.shared === undefined || local.shared === false, 'not SHARED — no invented visibility claim');

  assert.deepEqual(doc.routines.map((r) => r.name), ['Main']);
  const main = doc.routines[0];
  assert.equal(main.moduleName, 'E2Module', 'the slice still sees the module header');
  assert.equal(main.range.start.line, 6, 'the header line, in file coordinates');

  // The SET targets drive the undeclared check: neverSeen is the one name
  // that should warn (its DECLARE does not exist), and mining is what makes
  // it visible to the grammar path at all.
  assert.ok(
    doc.setTargets.some((x) => x.name === 'neverSeen' && x.range.start.line === 11),
    JSON.stringify(doc.setTargets.map((x) => [x.name, x.range.start.line]))
  );
});

// ── E-3: the legacy LOGICAL datatype ───────────────────────────────────────

test('legacy LOGICAL parses cleanly — the grammar false-flag is gone (E-3)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // Measured defect: `DECLARE legacy LOGICAL;` in an otherwise CLEAN file
  // yielded `Syntax error in a DECLARE statement.` plus an "expected a data
  // type here." lie from the tree path, while the fallback said nothing —
  // grammar mode was worse than its own degradation. The adjudication
  // (VERIFICATION.md): pre-ACE vocabulary, real legacy code, ACE 12 still
  // compiles it → the permissive grammar accepts it.
  const src = i12wrap('DECLARE legacy LOGICAL;', 'DECLARE off LOGICAL FALSE;', 'RETURN TRUE;');
  const doc = analyzeDocument(parse(src)!, src);
  assert.deepEqual(doc.syntaxIssues.map((i) => i.message), [], JSON.stringify(doc.syntaxIssues));
  assert.deepEqual(
    doc.declaredNames.map((d) => [d.name, d.detail]),
    [['legacy', 'LOGICAL'], ['off', 'LOGICAL']],
    'both declarations are indexed, type as written'
  );
});

test('a wholly collapsed module is reported on its definition line (I-12)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  // Damage so deep (unterminated IF) that the whole module becomes one ERROR:
  // the region opens with CREATE … MODULE, which is exactly what the reader
  // must fix, and the old behavior was a bare span over the entire file.
  const src = i12wrap('IF x = 1 THEN', '  SET y =', 'RETURN TRUE;');
  const doc = analyzeDocument(parse(src)!, src);
  assert.ok(
    doc.syntaxIssues.some(
      (i) =>
        /^Syntax error in a module definition\.$/.test(i.message) &&
        i.range.start.line === 0 &&
        i.range.end.line === 0
    ),
    JSON.stringify(doc.syntaxIssues.map((i) => [i.message, i.range.start.line]))
  );
});

test('two damage clusters clamped to the same line are one diagnostic (I-12)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const src = i12wrap('DECLARE x INT DEFAULT', '  1 +', 'RETURN TRUE;');
  const doc = analyzeDocument(parse(src)!, src);
  const keys = doc.syntaxIssues.map((i) => `${i.message}@${i.range.start.line}:${i.range.start.character}`);
  assert.equal(new Set(keys).size, keys.length, `no duplicates: ${JSON.stringify(keys)}`);
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

test('declarations and SET targets are mined from inside the damaged region (I-6)', async (t) => {
  if (!(await skipWithoutGrammar(t))) return;
  const src = [
    'CREATE COMPUTE MODULE Case13',
    '    CREATE FUNCTION Main() RETURNS BOOLEAN',
    '    BEGIN',
    '        DECLARE declaredVar INTEGER;',
    '        SET declaredVar = 1;',
    '        SET neverDeclared = declaredVar;',
    '        SET OutputRoot = InptuRoot;',
    '',
  ].join('\n');
  const doc = analyzeDocument(parse(src)!);
  assert.deepEqual(doc.modules.map((m) => m.name), ['Case13']);
  assert.deepEqual(doc.routines.map((r) => r.name), ['Main']);
  assert.equal(doc.routines[0].moduleName, 'Case13', 'mined routine knows its mined module');
  assert.deepEqual(doc.declaredNames.map((d) => d.name), ['declaredVar']);
  assert.deepEqual(doc.setTargets.map((s) => s.name), ['declaredVar', 'neverDeclared', 'OutputRoot']);
  assert.equal(
    doc.syntaxIssues.length,
    1,
    'damage nested inside the reported region adds no second `Syntax error.`'
  );
});
