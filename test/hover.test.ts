/**
 * Hover documentation for the document's OWN symbols (variables, parameters,
 * user-defined routines) on top of the built-in reference from src/data/.
 *
 * Like definitions.test.ts this file runs the heuristic path unconditionally —
 * that mode is a supported product surface — and additionally checks the
 * grammar path whenever the addon is available. The two differ in one
 * documented way: only the tree knows which module owns a declaration.
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
  assert.match(heuristic!, /\*at document level\*/, 'the fallback has no module model');
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
