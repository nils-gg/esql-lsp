import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CompletionItemKind } from 'vscode-languageserver';
import { detectCompletionContext, buildCompletionItems, wordBeingTyped } from '../src/completion';
import { initGrammar, parse, analyzeDocument } from '../src/parser';

test('detects parser-domain context after message tree root', () => {
  assert.equal(detectCompletionContext('SET x = InputRoot.'), 'domains');
  assert.equal(detectCompletionContext('SET x = InputRoot.J'), 'domains');
  assert.equal(detectCompletionContext('SET x = OutputRoot.JSON'), 'domains');
  assert.equal(detectCompletionContext('SET x = InputRoot.XMLNSC'), 'domains');
});

test('detects JSON. / XMLNSC. sub-contexts', () => {
  assert.equal(detectCompletionContext('SET x = InputRoot.JSON.'), 'json-data');
  assert.equal(detectCompletionContext('SET x = InputRoot.JSON.Data'), 'general');
  assert.equal(detectCompletionContext('SET x = OutputRoot.XMLNSC.'), 'xmlns-root');
});

test('detects LocalEnvironment, Database, types and general contexts', () => {
  assert.equal(detectCompletionContext('SET x = OutputLocalEnvironment.'), 'local-env');
  assert.equal(detectCompletionContext('SET x = Environment.'), 'local-env');
  assert.equal(detectCompletionContext('PASSTHRU(\'SELECT 1\') TO Database.'), 'datasource');
  assert.equal(detectCompletionContext('DECLARE x '), 'types');
  assert.equal(detectCompletionContext('DECLARE x CONSTANT '), 'types');
  assert.equal(detectCompletionContext('CREATE FUNCTION F() RETURNS '), 'types');
  assert.equal(detectCompletionContext('CREATE COMPUTE MODULE M'), 'general');
});

test('json-data offers Data', () => {
  const items = buildCompletionItems('json-data', 'SET x = InputRoot.JSON.', '');
  assert.deepEqual(items.map((i) => i.label), ['Data']);
});

test('domains context offers parser domains, filtered by prefix', () => {
  const all = buildCompletionItems('domains', 'SET x = InputRoot.', '');
  const labels = all.map((i) => i.label);
  for (const expected of ['JSON', 'XMLNSC', 'MRM', 'BLOB', 'Properties', 'MQMD']) {
    assert.ok(labels.includes(expected), `includes ${expected}`);
  }

  const filtered = buildCompletionItems('domains', 'SET x = InputRoot.J', '');
  assert.deepEqual(filtered.map((i) => i.label), ['JSON']);
});

test('types context offers data types incl. CONSTANT for DECLARE', () => {
  const decl = buildCompletionItems('types', 'DECLARE x ', '');
  const labels = decl.map((i) => i.label);
  assert.ok(labels.includes('CHARACTER'));
  assert.ok(labels.includes('INTEGER'));
  assert.ok(labels.includes('TIMESTAMP'));
  assert.ok(labels.includes('CONSTANT'));

  const ret = buildCompletionItems('types', 'CREATE FUNCTION F() RETURNS ', '');
  assert.ok(ret.every((i) => i.label !== 'CONSTANT'));
});

test('general context offers keywords, functions, tree vars and snippets', () => {
  const items = buildCompletionItems('general', '', '');
  const labels = items.map((i) => i.label);
  for (const expected of [
    'IF', 'WHILE', 'PROPAGATE', 'CREATE',
    'CAST', 'SUBSTRING', 'COALESCE', 'CARDINALITY', 'UUIDASCHAR',
    'InputRoot', 'OutputRoot', 'Environment',
    'module-compute', 'throw', 'trycatch',
  ]) {
    assert.ok(labels.includes(expected), `includes ${expected}`);
  }
});

test('general context offers variables declared in the document', () => {
  const src = "DECLARE myCounter INTEGER;\nSET myCounter = 1;\n";
  const items = buildCompletionItems('general', '', src);
  const myVar = items.find((i) => i.label === 'myCounter');
  assert.ok(myVar, 'myCounter offered');
  assert.match(myVar!.detail ?? '', /INTEGER/);
});

test('multi-name DECLARE offers every variable', () => {
  const src = 'DECLARE firstItem, secondItem INTEGER;\n';
  const items = buildCompletionItems('general', '', src);
  const first = items.find((i) => i.label === 'firstItem');
  const second = items.find((i) => i.label === 'secondItem');
  assert.ok(first, 'firstItem offered');
  assert.ok(second, 'secondItem offered');
  assert.match(first!.detail ?? '', /INTEGER/);
  assert.match(second!.detail ?? '', /INTEGER/);
});

test('general context filters by word being typed', () => {
  assert.equal(wordBeingTyped('SET x = COA'), 'COA');
  const items = buildCompletionItems('general', 'SET x = COA', '');
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => i.label.toLowerCase().startsWith('coa')));
  assert.ok(items.map((i) => i.label).includes('COALESCE'));
});

test('function items carry signature and markdown documentation', () => {
  const items = buildCompletionItems('general', 'CAST', '');
  const cast = items.find((i) => i.label === 'CAST')!;
  assert.ok(cast);
  assert.match(cast.detail ?? '', /CAST\(value AS datatype/);
  const doc = cast.documentation;
  assert.ok(doc && typeof doc !== 'string', 'markdown documentation');
  assert.equal(doc.kind, 'markdown');
  assert.match(doc.value, /Converts a value/);
});

/**
 * ISSUES.md I-17: the `general` list is six lists concatenated, and the same
 * word sits in two of them (`INTEGER` is a keyword and a type, `EXISTS` a
 * keyword and a function), so a client showed the identical row twice.
 */
test('general context offers each label at most once', () => {
  const items = buildCompletionItems('general', '', 'CREATE COMPUTE MODULE M\n');
  const labels = items.map((i) => i.label);
  const repeated = labels.filter((l, i) => labels.indexOf(l) !== i);
  assert.deepEqual(repeated, [], 'no label appears twice');
  assert.ok(labels.length > 200, 'and the list is still the full list');

  // The surviving entry is the one that says the most about the completion.
  const exists = items.find((i) => i.label === 'EXISTS')!;
  assert.equal(exists.kind, CompletionItemKind.Function, 'EXISTS survives as the function');
  assert.match(exists.detail ?? '', /EXISTS\(/);
  const integer = items.find((i) => i.label === 'INTEGER')!;
  assert.match(integer.detail ?? '', /data type/, 'INTEGER survives as the type');

  // Deliberately NOT merged: same word, different text inserted.
  assert.ok(labels.includes('IF'), 'the IF keyword');
  assert.ok(labels.includes('if'), 'and the if snippet, which expands a block');
});

test('a declared name that shadows a built-in is offered as the declaration', () => {
  const src = [
    'CREATE COMPUTE MODULE M',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'DECLARE floor CHARACTER;',
    'SET floor = \'x\';',
    'RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const items = buildCompletionItems('general', '', src, undefined, { line: 4, character: 0 });
  const floor = items.find((i) => i.label === 'floor');
  assert.ok(floor, 'the user name is offered');
  assert.match(floor!.detail ?? '', /Declared: CHARACTER/);
});

/**
 * ISSUES.md I-16: every declared name carries the scope the analysis computed,
 * and the list has to respect it — a file with N routines used to offer all of
 * them at every position.
 */
const SCOPED = [
  'CREATE COMPUTE MODULE Scoped', // 0
  'DECLARE moduleLevel CHARACTER;', // 1
  'CREATE FUNCTION First() RETURNS BOOLEAN', // 2
  'BEGIN', // 3
  'DECLARE onlyHere CHARACTER;', // 4
  "SET onlyHere = 'x';", // 5
  'RETURN TRUE;', // 6
  'END;', // 7
  'CREATE FUNCTION Second() RETURNS BOOLEAN', // 8
  'BEGIN', // 9
  'SET moduleLevel = \'y\';', // 10
  'RETURN TRUE;', // 11
  'END;', // 12
  'END MODULE;', // 13
  '',
].join('\n');

/**
 * The declared-name labels in a list. Message tree variables are Variable kind
 * too, so the `Declared:` detail is what identifies the document's own names.
 */
const declared = (items: { detail?: string; label: string }[]) =>
  items.filter((i) => /^Declared:/.test(i.detail ?? '')).map((i) => i.label);

test('completion offers only declared names whose scope holds the position (fallback)', () => {
  const insideFirst = buildCompletionItems('general', '', SCOPED, undefined, {
    line: 5,
    character: 0,
  });
  assert.ok(declared(insideFirst).includes('onlyHere'), 'its own routine declares it');
  assert.ok(declared(insideFirst).includes('moduleLevel'), 'module level is visible');

  const insideSecond = buildCompletionItems('general', '', SCOPED, undefined, {
    line: 10,
    character: 0,
  });
  assert.ok(!declared(insideSecond).includes('onlyHere'), 'the other routine is not');
  assert.ok(declared(insideSecond).includes('moduleLevel'), 'module level still is');

  const afterEnd = buildCompletionItems('general', '', SCOPED, undefined, {
    line: 14,
    character: 0,
  });
  assert.deepEqual(declared(afterEnd), [], 'nothing is visible past END MODULE');
});

test('the same filtering applies to names from the parse tree', async (t) => {
  if (!(await initGrammar())) {
    t.skip('tree-sitter addon unavailable — no DocAnalysis to filter');
    return;
  }
  const doc = analyzeDocument(parse(SCOPED)!);
  const all = doc.declaredNames.map((d) => d.name);
  assert.ok(all.includes('onlyHere'), 'the tree sees every name in the file');

  const insideSecond = buildCompletionItems(
    'general',
    '',
    SCOPED,
    doc.declaredNames,
    { line: 10, character: 0 }
  );
  assert.ok(!declared(insideSecond).includes('onlyHere'), 'but offers only what is visible');
  assert.ok(declared(insideSecond).includes('moduleLevel'));

  // Parameters are visible throughout their routine, header included.
  const withParam = [
    'CREATE COMPUTE MODULE P',
    'CREATE PROCEDURE Helper(IN amount INTEGER)',
    'BEGIN',
    'RETURN;',
    'END;',
    'CREATE FUNCTION Main() RETURNS BOOLEAN',
    'BEGIN',
    'RETURN TRUE;',
    'END;',
    'END MODULE;',
    '',
  ].join('\n');
  const pdoc = analyzeDocument(parse(withParam)!);
  const inHelper = buildCompletionItems('general', '', withParam, pdoc.declaredNames, {
    line: 3,
    character: 0,
  });
  assert.ok(declared(inHelper).includes('amount'), 'parameter visible in its own body');
  const inMain = buildCompletionItems('general', '', withParam, pdoc.declaredNames, {
    line: 7,
    character: 0,
  });
  assert.ok(!declared(inMain).includes('amount'), 'and not in another routine');
});

test('without a position nothing is filtered (the documented fallback contract)', () => {
  const items = buildCompletionItems('general', '', SCOPED);
  assert.ok(declared(items).includes('onlyHere'), 'every name in the file is offered');
});
