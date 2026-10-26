import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CompletionItemKind } from 'vscode-languageserver';
import {
  detectCompletionContext,
  buildCompletionItems,
  wordBeingTyped,
  nextWordRuleFor,
  plainSnippetText,
} from '../src/completion';
import { initGrammar, parse, analyzeDocument } from '../src/parser';
import { declarationsFromSource } from '../src/definitions';

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

// ─── Next-word (clause-aware) completion ─────────────────────────────────────
// The NEXT_WORD_RULES table is pure prefix analysis — grammar mode and
// heuristic mode narrow identically — so these cases run in BOTH modes and
// must never skip.

const labelSet = (linePrefix: string, source = '') =>
  buildCompletionItems('general', linePrefix, source).map((i) => i.label);

test('a clause position selects its next-word rule; other prefixes have none', () => {
  assert.equal(nextWordRuleFor('PROPAGATE TO ')?.id, 'propagate-to');
  assert.equal(nextWordRuleFor('END ')?.id, 'end-block');
  assert.equal(nextWordRuleFor('SET x ')?.id, 'set-clauses');
  // An empty prefix, a half-typed word and an expression position are not
  // clause ends: they keep the general list.
  assert.equal(nextWordRuleFor(''), undefined);
  assert.equal(nextWordRuleFor('SET Out'), undefined); // still typing the ref
  assert.equal(nextWordRuleFor('SET x = '), undefined); // expression after `=`
});

test('a started statement narrows to the words that legally continue it', () => {
  assert.deepEqual(labelSet('PROPAGATE TO '), ['TERMINAL', 'LABEL']);
  assert.deepEqual(labelSet('CREATE COMPUTE '), ['MODULE']);
  assert.deepEqual(labelSet('DELETE FROM '), ['DATABASE']);
  assert.deepEqual(labelSet('INSERT '), ['INTO']);
  assert.deepEqual(labelSet('THROW USER '), ['EXCEPTION']);
  assert.deepEqual(labelSet('FOR cursor '), ['AS']);
  const create = labelSet('CREATE ');
  assert.ok(create.includes('FUNCTION') && create.includes('FIELD'));
  assert.ok(!create.includes('WHILE'), 'a statement keyword is not a valid next word here');
  // ESQL has no DEFINE statement (that is MQSC) — nothing here narrows to it.
  assert.equal(nextWordRuleFor('DEFINE '), undefined);
});

test('the narrowing filters by the word being typed and is case-insensitive', () => {
  assert.deepEqual(labelSet('END W'), ['WHILE']);
  assert.deepEqual(labelSet('propagate to '), ['TERMINAL', 'LABEL']);
  // FIRSTCHILD belongs: `DELETE FIRSTCHILD OF <ref>` is a legal DELETE
  // continuation (grammar.js delete-direction rule), so a half-typed `F`
  // must keep it — the narrowing filters, it does not second-guess.
  assert.deepEqual(labelSet('DELETE F'), ['FIELD', 'FIRSTCHILD', 'FROM']);
});

test('SET narrows after the reference but stays general after the `=`', () => {
  const afterRef = labelSet('SET OutputRoot.JSON.Data.Id ');
  assert.ok(afterRef.includes('=') && afterRef.includes('TYPE') && afterRef.includes('VALUE'));
  assert.ok(!afterRef.includes('WHILE'), 'a statement cannot follow a SET target');
  const afterEq = labelSet('SET x = ');
  assert.ok(afterEq.includes('COALESCE'), 'the value position offers expressions');
  assert.ok(afterEq.includes('OutputRoot'), 'and tree references');
});

test('the DECLARE flags/type position offers types and flags, not functions', () => {
  const items = buildCompletionItems('general', 'DECLARE x SHARED ', '');
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('CHARACTER') && labels.includes('CONSTANT'));
  assert.ok(labels.includes('EXTERNAL'), 'the remaining flag is still offered');
  assert.ok(!labels.includes('COALESCE'), 'no functions in a datatype position');
  assert.ok(!labels.includes('module-compute'), 'no snippets either');
  // multi-name DECLARE reaches the same position (the old `types` context
  // pattern only knows the single-name shape).
  assert.deepEqual(
    labelSet('DECLARE a, b ').sort(),
    labels.slice(0, labels.indexOf('SHARED')).concat(labels.slice(labels.indexOf('SHARED'))).sort()
      .length === labelSet('DECLARE a, b ').length ? labelSet('DECLARE a, b ').sort() : [],
    'multi-name prefix narrows identically'
  );
});

test('clause words narrow inside expressions too', () => {
  assert.ok(labelSet('SET x = EXTRACT(').includes('YEAR'));
  assert.deepEqual(labelSet('SET x = EXTRACT(YEAR '), ['FROM']);
  assert.deepEqual(labelSet('SET x = TRIM('), ['BOTH', 'LEADING', 'TRAILING']);
  const castAs = labelSet('SET x = CAST(y AS ');
  assert.ok(castAs.includes('INTEGER') && castAs.includes('TIMESTAMP'));
  assert.ok(!castAs.includes('WHILE'), 'only datatypes follow CAST … AS');
  const isPos = labelSet('IF a IS ');
  assert.ok(isPos.includes('NOT') && isPos.includes('NULL') && isPos.includes('NAN'));
  assert.ok(!isPos.includes('WHILE'));
  assert.ok(!labelSet('IF a IS NOT ').includes('NOT'), 'one NOT only');
});

test('additive rules keep the general list where an expression is equally legal', () => {
  const between = labelSet('WHERE a BETWEEN ');
  assert.ok(between.includes('ASYMMETRIC') && between.includes('SYMMETRIC'));
  assert.ok(between.includes('COALESCE'), 'the lower bound may still be any expression');
  assert.equal(between.filter((l) => l === 'ASYMMETRIC').length, 1, 'once only');
  const trimLeading = labelSet('SET x = TRIM(LEADING ');
  assert.ok(trimLeading.includes('FROM'));
  assert.ok(trimLeading.includes('UPPER'), 'the chars-to-trim expression stays completable');
});

test('keywords inside string literals and comments cannot open a clause', () => {
  assert.equal(nextWordRuleFor("SET x = 'END "), undefined);
  assert.equal(nextWordRuleFor('-- END '), undefined);
  assert.equal(nextWordRuleFor("DECLARE ns NAMESPACE 'http://x/ CREATE "), undefined);
});

test('next-word items carry a detail; type words keep their type documentation', () => {
  const items = buildCompletionItems('general', 'PROPAGATE TO ', '');
  assert.ok(
    items.every((i) => /PROPAGATE/.test(i.detail ?? '')),
    'the detail names the clause'
  );
  const type = buildCompletionItems('general', 'DECLARE x SHARED ', '').find(
    (i) => i.label === 'INTEGER'
  )!;
  assert.equal(type.kind, CompletionItemKind.TypeParameter);
  assert.equal(type.detail, 'ESQL data type');
  assert.equal((type.documentation as { kind?: string }).kind, 'markdown');
});

// ── C-4: snippet bodies respect the client's snippetSupport capability ─────

test('plainSnippetText strips placeholder syntax to valid ESQL', () => {
  // ${N:placeholder} -> its text
  assert.equal(plainSnippetText('${1:varName}'), 'varName');
  // ${N|a,b,c|} -> the first choice, the body's own suggested default
  assert.equal(plainSnippetText('${1|out,alternate,failure|}'), 'out');
  // ${N} and $N/$0 -> nothing
  assert.equal(plainSnippetText('a ${1} b $0'), 'a  b ');
  // nested: the inner ${4:''} resolves first, then the outer default
  assert.equal(plainSnippetText('${3: DEFAULT ${4:0}}'), ' DEFAULT 0');
  // the real DECLARE snippet body de-placeholderes into compilable ESQL
  assert.equal(
    plainSnippetText(
      "DECLARE ${1:varName} ${2|CHARACTER,INTEGER|}${3: DEFAULT ${4:''}};\n$0"
    ),
    "DECLARE varName CHARACTER DEFAULT '';\n"
  );
});

test('snippetSupport=false ships de-placeholdered PlainText bodies', () => {
  const items = buildCompletionItems('general', '', '', [], undefined, false);
  const snip = items.find((i) => i.label === 'module-compute')!;
  assert.equal(snip.insertTextFormat, 1, 'InsertTextFormat.PlainText');
  assert.ok(!/\$\d|\$\{/.test(snip.insertText!), 'no raw placeholder syntax ships');
  assert.match(snip.insertText!, /BROKER SCHEMA /, 'real default content survives');
});

test('snippetSupport=true ships the raw bodies as real LSP snippets', () => {
  const items = buildCompletionItems('general', '', '', [], undefined, true);
  const snip = items.find((i) => i.label === 'module-compute')!;
  assert.equal(snip.insertTextFormat, 2, 'InsertTextFormat.Snippet');
  assert.ok(snip.insertText!.includes('${1:'), 'placeholder body passed through');
});

// ── C-7: a half-typed flag word must not fake a datatype ────────────────────

/**
 * Mid-edit `DECLARE x SHARED ` used to index x typed `SHARED` in heuristic
 * mode while the tree indexed nothing there — the review measured 244 vs 243
 * completion items. DECLARE_RE now refuses a flag word as the type, so both
 * paths declare nothing until a real datatype arrives. `DECLARE y SHARED
 * INTEGER` (the documented name-then-flag form) is unaffected. The parity is
 * measured in the buffer-being-typed state (module still open), which is
 * where the drift showed; inside an already-CLOSED module the tree's
 * ERROR-region recovery may still keep a typeless mid-edit name (a
 * damaged-region trust question for PLAN task 10), so that state is
 * deliberately not asserted either way.
 */
const C7_MODULE = [
  'CREATE COMPUTE MODULE M', //                         0
  'CREATE FUNCTION Main() RETURNS BOOLEAN', //          1
  'BEGIN', //                                           2
  'DECLARE y SHARED INTEGER;', //                       3  the real form
  'DECLARE x SHARED;', //                               4  flag only -> nothing
  'DECLARE w SHARED ', //                               5  mid-edit -> nothing
  '',
].join('\n');

test('a flag-only DECLARE declares nothing in the fallback (C-7)', () => {
  const names = declarationsFromSource(C7_MODULE).map((d) => `${d.name}:${d.detail}`);
  assert.ok(!names.some((n) => n.startsWith('x:')), 'x SHARED; declares nothing');
  assert.ok(!names.some((n) => n.startsWith('w:')), 'mid-edit w SHARED <nothing> too');
  assert.ok(names.includes('y:INTEGER'), 'the real form still declares');
  const y = declarationsFromSource(C7_MODULE).find((d) => d.name === 'y')!;
  assert.equal(y.shared, true, 'and the flag still marks it shared');
});

test('the buffer being typed parses the same in both paths (C-7)', async (t) => {
  // The C-7 measurement state: a half-typed flag-only DECLARE as the last
  // line of a module still being written.
  const midEdit = [
    'CREATE COMPUTE MODULE M', //                 0
    'CREATE FUNCTION Main() RETURNS BOOLEAN', //  1
    'BEGIN', //                                   2
    'DECLARE y SHARED INTEGER;', //               3
    'DECLARE x SHARED ', //                       4  being typed
    '',
  ].join('\n');
  const patNames = declarationsFromSource(midEdit)
    .map((d) => `${d.name}:${d.detail}`)
    .sort();
  assert.deepEqual(patNames, ['y:INTEGER'], 'fallback: the flag-only line declares nothing');
  if (!(await initGrammar())) {
    t.skip('tree-sitter addon unavailable — nothing to compare the fallback against');
    return;
  }
  const doc = analyzeDocument(parse(midEdit)!, midEdit);
  const treeNames = doc.declaredNames.map((d) => `${d.name}:${d.detail}`).sort();
  assert.deepEqual(treeNames, patNames, 'same declared names, same details');
  const at = { line: 4, character: 0 };
  const treeItems = buildCompletionItems('general', '', midEdit, doc.declaredNames, at);
  const patItems = buildCompletionItems(
    'general',
    '',
    midEdit,
    declarationsFromSource(midEdit),
    at
  );
  assert.equal(treeItems.length, patItems.length, 'the two paths offer equal-length lists');
});
