/**
 * Hover documentation for the document's OWN symbols (variables, parameters,
 * user-defined routines) on top of the built-in reference from src/data/.
 *
 * Like definitions.test.ts this file runs the heuristic path unconditionally —
 * that mode is a supported product surface — and additionally checks the grammar
 * path whenever the addon is available. The two are expected to agree about
 * *which* declaration a position means and who owns it; they differ only in how
 * precisely each one computes the ranges.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Hover } from 'vscode-languageserver';
import { hoverAt } from '../src/hover';
import { initGrammar, parse, analyzeDocument, grammarReady, DocAnalysis } from '../src/parser';

const SRC = [
  'BROKER SCHEMA com.example.flow;',                        // 0
  'CREATE COMPUTE MODULE OrderProcessing',                  // 1
  'DECLARE orderRef REFERENCE InputRoot.JSON.Data;',        // 2
  'DECLARE limit CONSTANT INTEGER 10;',                     // 3
  'CREATE PROCEDURE ValidateOrder(IN orderId INTEGER)',     // 4
  'BEGIN',                                                  // 5
  'DECLARE isValid BOOLEAN;',                               // 6
  'SET isValid = TRUE;',                                    // 7
  'SET orderRef = InputRoot.JSON.Data;',                    // 8
  'END;',                                                   // 9
  'CREATE FUNCTION Main() RETURNS BOOLEAN',                 // 10
  'BEGIN',                                                  // 11
  'DECLARE LENGTH CHARACTER;',                              // 12
  'SET LENGTH = SUBSTRING(orderRef, 1, 2);',                // 13
  'CALL ValidateOrder(1);',                                 // 14
  'RETURN TRUE;',                                           // 15
  'END;',                                                   // 16
  'END MODULE;',                                            // 17
  '',
].join('\n');

const LINES = SRC.split('\n');
const at = (line: number, word: string, from = 0) => LINES[line].indexOf(word, from);

function text(hover: Hover | null): string | null {
  if (!hover) return null;
  assert.equal((hover.contents as { kind: string }).kind, 'markdown');
  return (hover.contents as { value: string }).value;
}

let cachedDoc: DocAnalysis | undefined;
let checked = false;

async function doc(): Promise<DocAnalysis | undefined> {
  if (!checked) {
    checked = true;
    await initGrammar();
    cachedDoc = grammarReady() ? analyzeDocument(parse(SRC)!) : undefined;
  }
  return cachedDoc;
}

/** Hovers `line`/`character` in heuristic mode and (when possible) tree mode. */
async function both(
  line: number,
  character: number
): Promise<{ heuristic: string | null; grammar: string | null }> {
  const analysis = await doc();
  return {
    heuristic: text(hoverAt(SRC, line, character)),
    grammar: analysis ? text(hoverAt(SRC, line, character, analysis)) : null,
  };
}

test('hover documents a declared variable with its type', async () => {
  const { heuristic, grammar } = await both(8, at(8, 'orderRef', 4));
  assert.match(heuristic!, /### `orderRef`/);
  assert.match(heuristic!, /\*\*Declared variable\*\* — `REFERENCE`/);
  // Both modes know the module now: the fallback reads `CREATE … MODULE`
  // headers itself (I-15 — it used to lose this line without a tree).
  assert.match(heuristic!, /\*in module `OrderProcessing`\*/);
  if (grammar) {
    assert.match(grammar, /\*\*Declared variable\*\* — `REFERENCE`/);
    assert.match(grammar, /\*in module `OrderProcessing`\*/, 'the tree knows the owner');
  }
});

test('hover marks a CONSTANT declaration as such', async () => {
  const { heuristic, grammar } = await both(3, at(3, 'limit'));
  assert.match(heuristic!, /CONSTANT INTEGER/);
  assert.match(heuristic!, /_Constant: cannot be reassigned\._/);
  if (grammar) assert.match(grammar, /_Constant: cannot be reassigned\._/);
});

test('hover documents a routine parameter and names its routine', async () => {
  const { heuristic, grammar } = await both(4, at(4, 'orderId'));
  assert.match(heuristic!, /\*\*Routine parameter\*\* — `INTEGER`/);
  assert.match(heuristic!, /\*in `ValidateOrder\(\)`\*/);
  if (grammar) assert.match(grammar, /\*in `ValidateOrder\(\)`\*/);
});

test('hover documents a DECLARE inside a routine body', async () => {
  const { heuristic } = await both(7, at(7, 'isValid'));
  assert.match(heuristic!, /### `isValid`/);
  assert.match(heuristic!, /\*\*Declared variable\*\* — `BOOLEAN`/);
  assert.match(heuristic!, /\*in `ValidateOrder\(\)`\*/);
});

test('hover shows the signature of a user-defined procedure', async () => {
  for (const [line, character] of [
    [4, at(4, 'ValidateOrder')], // header
    [14, at(14, 'ValidateOrder')], // CALL site
  ]) {
    const { heuristic, grammar } = await both(line, character);
    assert.match(heuristic!, /\*\*ESQL procedure\*\*/);
    assert.match(heuristic!, /```esql\nCREATE PROCEDURE ValidateOrder\(IN orderId INTEGER\)\n```/);
    if (grammar) assert.match(grammar!, /CREATE PROCEDURE ValidateOrder\(IN orderId INTEGER\)/);
  }
});

test('hover shows RETURNS in a function signature', async () => {
  const { heuristic, grammar } = await both(10, at(10, 'Main'));
  assert.match(heuristic!, /\*\*ESQL function\*\*/);
  assert.match(heuristic!, /CREATE FUNCTION Main\(\) RETURNS BOOLEAN/);
  if (grammar) assert.match(grammar!, /CREATE FUNCTION Main\(\) RETURNS BOOLEAN/);
});

test('a user declaration wins over a built-in of the same name', async () => {
  const { heuristic, grammar } = await both(13, at(13, 'LENGTH'));
  assert.match(heuristic!, /\*\*Declared variable\*\* — `CHARACTER`/);
  assert.doesNotMatch(heuristic!, /built-in function/, 'the declaration in front of the user wins');
  if (grammar) assert.match(grammar!, /Declared variable/);
});

test('built-in functions, tree variables and domains still document', async () => {
  const fn = await both(13, at(13, 'SUBSTRING'));
  assert.match(fn.heuristic!, /ESQL built-in function/);
  assert.match(fn.heuristic!, /SUBSTRING\(string FROM start FOR length\)/);

  const root = await both(8, at(8, 'InputRoot'));
  assert.match(root.heuristic!, /ESQL message tree variable/);

  const domain = await both(8, at(8, 'JSON'));
  assert.match(domain.heuristic!, /ESQL parser \/ message domain/);

  const type = await both(3, at(3, 'INTEGER', 20));
  assert.match(type.heuristic!, /ESQL data type/);
});

/**
 * ISSUES.md I-15: hover used to take the FIRST match in file order, so with a
 * name declared twice it described the wrong declaration — while
 * go-to-definition at the same cursor resolved the scope. The two features are
 * required to agree.
 */
const SHADOW = [
  'CREATE COMPUTE MODULE Shadowing', // 0
  'CREATE FUNCTION First() RETURNS BOOLEAN', // 1
  'BEGIN', // 2
  "DECLARE value CHARACTER;", // 3
  "SET value = 'first';", // 4
  'RETURN TRUE;', // 5
  'END;', // 6
  'CREATE FUNCTION Second() RETURNS INTEGER', // 7
  'BEGIN', // 8
  'DECLARE value INTEGER 2;', // 9
  'SET value = 3;', // 10
  'RETURN value;', // 11
  'END;', // 12
  'END MODULE;', // 13
  '',
].join('\n');
const SHADOW_LINES = SHADOW.split('\n');
const there = (line: number, word: string, from = 0) => SHADOW_LINES[line].indexOf(word, from);

/** Hovers SHADOW at a position in both modes. */
async function bothShadow(line: number, character: number) {
  const analysis = await doc();
  const tree = analysis ? analyzeDocument(parse(SHADOW)!) : undefined;
  return {
    heuristic: text(hoverAt(SHADOW, line, character)),
    grammar: tree ? text(hoverAt(SHADOW, line, character, tree)) : null,
  };
}

test('a name declared in two routines hovers the one the cursor is inside', async () => {
  for (const [line, type, routine] of [
    [4, 'CHARACTER', 'First'],
    [10, 'INTEGER', 'Second'],
  ] as const) {
    const { heuristic, grammar } = await bothShadow(line, there(line, 'value'));
    assert.match(heuristic!, /### `value`/);
    assert.match(
      heuristic!,
      new RegExp(`\\*\\*Declared variable\\*\\* — \`${type}\``),
      `line ${line + 1} sees the ${type} declaration`
    );
    assert.match(heuristic!, new RegExp(`\\*in \`${routine}\\(\\)\`\\*`));
    if (grammar) {
      assert.match(grammar!, new RegExp(`\\*\\*Declared variable\\*\\* — \`${type}\``));
      assert.match(grammar!, new RegExp(`\\*in \`${routine}\\(\\)\`\\*`));
    }
  }
});

/** Two modules, one routine name: hover must not describe the first file order. */
const TWOMAIN = [
  'CREATE COMPUTE MODULE First_Module', // 0
  'CREATE FUNCTION Main() RETURNS BOOLEAN', // 1
  'BEGIN', // 2
  'RETURN TRUE;', // 3
  'END;', // 4
  'END MODULE;', // 5
  '', // 6
  'CREATE COMPUTE MODULE Second_Module', // 7
  'CREATE FUNCTION Main() RETURNS BOOLEAN', // 8
  'BEGIN', // 9
  'RETURN FALSE;', // 10
  'END;', // 11
  'END MODULE;', // 12
  '',
].join('\n');
const TWOMAIN_LINES = TWOMAIN.split('\n');

test('with two Main() routines, hover names the module the cursor is in', async () => {
  for (const [line, module] of [
    [1, 'First_Module'],
    [8, 'Second_Module'],
  ] as const) {
    const character = TWOMAIN_LINES[line].indexOf('Main');
    const analysis = await doc();
    const tree = analysis ? analyzeDocument(parse(TWOMAIN)!) : undefined;
    const heuristic = text(hoverAt(TWOMAIN, line, character));
    assert.match(heuristic!, /\*\*ESQL function\*\*/);
    assert.match(
      heuristic!,
      new RegExp(`\\*in module \`${module}\`\\*`),
      `line ${line + 1} belongs to ${module} (heuristic)`
    );
    if (tree) {
      const grammar = text(hoverAt(TWOMAIN, line, character, analyzeDocument(parse(TWOMAIN)!)));
      assert.match(
        grammar!,
        new RegExp(`\\*in module \`${module}\`\\*`),
        `line ${line + 1} belongs to ${module} (grammar)`
      );
    }
  }
});

/**
 * Correctness review 2026-10-30: hover resolved a routine name with
 * `routineByNameAt`, whose fallback picked the FIRST same-named routine in
 * file order — so at an unqualified call into a name several other modules
 * share, hover silently described one module while definition/references/
 * rename (all on `routineTargetsFor`) listed them all. Hover now goes through
 * the same resolver and says the name is ambiguous, both modes alike.
 */
const AMBIGUOUS_CALL = [
  'CREATE COMPUTE MODULE CallerA', //                    0
  'CREATE FUNCTION Main() RETURNS BOOLEAN', //           1
  'BEGIN', //                                            2
  '  CALL Helper();', //                                 3 — whose Helper?
  '  RETURN TRUE;', //                                   4
  'END;', //                                             5
  'END MODULE;', //                                      6
  'CREATE COMPUTE MODULE ModuleB', //                    7
  'CREATE FUNCTION Helper() RETURNS BOOLEAN', //         8
  'BEGIN RETURN TRUE; END;', //                          9
  'END MODULE;', //                                      10
  'CREATE COMPUTE MODULE ModuleC', //                    11
  'CREATE FUNCTION Helper() RETURNS BOOLEAN', //         12
  'BEGIN RETURN TRUE; END;', //                          13
  'END MODULE;', //                                      14
  '',
].join('\n');

test('an ambiguous unqualified CALL hovers as ambiguous, like definition lists it (review 2026-10-30)', async () => {
  const line = 3;
  const character = AMBIGUOUS_CALL.split('\n')[line].indexOf('Helper');
  const heuristic = text(hoverAt(AMBIGUOUS_CALL, line, character));
  assert.match(heuristic!, /\*\*Ambiguous name\*\*/, 'the card admits it cannot pick');
  assert.match(heuristic!, /module `ModuleB`/, 'candidate one is named');
  assert.match(heuristic!, /module `ModuleC`/, 'candidate two is named too');

  await initGrammar();
  if (grammarReady()) {
    const tree = analyzeDocument(parse(AMBIGUOUS_CALL)!);
    const grammar = text(hoverAt(AMBIGUOUS_CALL, line, character, tree));
    assert.match(grammar!, /\*\*Ambiguous name\*\*/, 'grammar mode says the same');
    assert.match(grammar!, /module `ModuleB`/);
    assert.match(grammar!, /module `ModuleC`/);
  }

  // The single-candidate cross-module shape keeps its old routine card:
  // nothing about a name only ONE module owns was ever ambiguous.
  const single = AMBIGUOUS_CALL.split('\n').slice(0, 11).join('\n') + '\n';
  const card = text(hoverAt(single, line, character));
  assert.match(card!, /\*\*ESQL function\*\*/);
  assert.match(card!, /\*in module `ModuleB`\*/);
  assert.doesNotMatch(card!, /Ambiguous/);
});

test('the short type words document themselves on hover (review 2026-10-30)', () => {
  const src = 'DECLARE n INT;\nSET n = CAST(m AS VARCHAR(4));\n';
  for (const [line, word] of [
    [0, 'INT'],
    [1, 'VARCHAR'],
  ] as const) {
    const card = text(hoverAt(src, line, src.split('\n')[line].indexOf(word)));
    assert.match(card!, /\*\*ESQL data type\*\*/, `${word} is documented after the table fix`);
  }
});

test('hovering inside a string or comment yields nothing', async () => {
  const inString = hoverAt("SET note = 'isValid here';", 0, 20);
  assert.equal(inString, null);
  const inComment = hoverAt('-- isValid here\n', 0, 5);
  assert.equal(inComment, null);
});

test('undocumented words yield nothing', async () => {
  const { heuristic, grammar } = await both(3, at(3, 'CONSTANT'));
  assert.equal(heuristic, null);
  if (grammar) assert.equal(grammar, null);
});

test('a module and the BROKER SCHEMA document themselves', async () => {
  // Someone hovering the module name is orienting themselves in an unfamiliar
  // file, so the answer has to name the kind of module and what is in it —
  // hovering used to return nothing at all for these two (ISSUES.md I-11).
  const mod = await both(1, at(1, 'OrderProcessing'));
  assert.match(mod.heuristic!, /\*\*COMPUTE MODULE\*\*/);
  assert.match(mod.heuristic!, /declared at line 2/);
  assert.match(mod.heuristic!, /Contains 2 routines: `ValidateOrder`, `Main`/);
  if (mod.grammar) {
    assert.match(mod.grammar!, /\*\*COMPUTE MODULE\*\*/);
    assert.match(mod.grammar!, /Contains 2 routines/);
  }

  // A dotted schema id: `wordAt` stops at the dots, so any segment of the name
  // has to answer.
  for (const segment of ['com', 'example', 'flow']) {
    const schema = await both(0, at(0, segment));
    assert.match(schema.heuristic!, /com\.example\.flow/);
    assert.match(schema.heuristic!, /\*\*BROKER SCHEMA\*\*/);
    if (schema.grammar) assert.match(schema.grammar!, /com\.example\.flow/);
  }

  // A declared variable is still itself, not the schema.
  const declared = await both(3, at(3, 'limit'));
  assert.match(declared.heuristic!, /Declared variable/);
});
