/**
 * Quoted identifiers as first-class scanner tokens (list.md issue 6 /
 * enhancement 20).
 *
 * The old navigation code found `"…"` names with a raw-line regex, which the
 * tests below would have failed: it answered for quoted text inside comments
 * and inside `'…'` strings, and it split the escaped spelling `"a""b"` into
 * two bogus names. The scanner now emits tokens carrying the normalized
 * value AND the source range; wordAtPosition and occurrences consume them.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scan, unquoteESQLName } from '../src/scanner';
import { wordAtPosition, occurrences, definitionAt, referencesAt } from '../src/definitions';

const SAMPLE = [
  'CREATE COMPUTE MODULE QuotedMod', // 0
  '  DECLARE "script-encoded-hostname" EXTERNAL CHARACTER;', // 1
  '  DECLARE "a""b" CHARACTER;', // 2
  '  CREATE FUNCTION Main() RETURNS BOOLEAN', // 3
  '  BEGIN', // 4
  '    SET "script-encoded-hostname" = \'host\';', // 5
  "    SET \"a\"\"b\" = 'x';", // 6
  '    -- a note mentioning "script-encoded-hostname" and "ghost"', // 7
  "    SET msg = 'she said \"hi\" loudly';", // 8
  '    RETURN TRUE;', // 9
  '  END;', // 10
  'END MODULE;', // 11
  '',
].join('\n');

test('scan emits quoted-identifier tokens with value and range', () => {
  const { quotedTokens } = scan(SAMPLE);
  const seen = quotedTokens.map((t) => `${t.line}:${t.startCol}-${t.endCol}=${t.value}`);
  assert.deepEqual(seen, [
    '1:10-35=script-encoded-hostname',
    '2:10-16=a"b',
    '5:8-33=script-encoded-hostname',
    '6:8-14=a"b',
  ]);
  // ranges are inclusive of the quotes, values are normalized ONCE
  for (const t of quotedTokens) {
    const raw = SAMPLE.split('\n')[t.line].slice(t.startCol, t.endCol);
    assert.equal(unquoteESQLName(raw), t.value);
  }
});

test('no tokens for quoted text inside comments or single-quoted strings', () => {
  const { quotedTokens } = scan(SAMPLE);
  const values = quotedTokens.map((t) => t.value);
  assert.ok(!values.includes('ghost'), 'comment text is not an identifier');
  assert.ok(!values.includes('hi'), 'string content is not an identifier');
});

test('wordAtPosition answers quoted names — but never in comments or strings', () => {
  const { lines, rawLines, quotedTokens } = scan(SAMPLE);
  // mid-name, on the opening quote, on the closing quote
  for (const col of [20, 10, 11, 34, 35]) {
    const w = wordAtPosition(lines, rawLines, 1, col, quotedTokens);
    assert.equal(w?.word, 'script-encoded-hostname', `col ${col}`);
    assert.deepEqual(w?.range, { start: { line: 1, character: 11 }, end: { line: 1, character: 34 } });
  }
  // the "" escape reads as ONE name: cursor anywhere in line 6's quoted span
  const esc = wordAtPosition(lines, rawLines, 6, 10, quotedTokens);
  assert.equal(esc?.word, 'a"b');
  assert.equal(esc?.range.start.character, 9);
  assert.equal(esc?.range.end.character, 13);
  // the two regex-era false positives are gone
  assert.equal(wordAtPosition(lines, rawLines, 7, 30, quotedTokens), null, 'comment "ghost"');
  assert.equal(wordAtPosition(lines, rawLines, 7, 23, quotedTokens), null, 'comment quoted name');
  assert.equal(wordAtPosition(lines, rawLines, 8, 22, quotedTokens), null, 'string "hi"');
});

test('quoted columns after non-ASCII text are client columns (with the mask agree)', () => {
  // one é (1 code unit, 2 UTF-8 bytes) inside a string before the quote —
  // the token column must match where wordAt(masked line) sees the bare word.
  const text = "SET x = 'é'; DECLARE \"nàmed\" CHARACTER;";
  const { lines, rawLines, quotedTokens } = scan(text);
  assert.equal(quotedTokens.length, 1);
  const t = quotedTokens[0];
  assert.equal(t.value, 'nàmed');
  assert.equal(t.startCol, 21, 'é counts as ONE client column (utf8 would say 22)');
  const bare = wordAtPosition(lines, rawLines, 0, 4, quotedTokens); // on `x`
  assert.equal(bare?.word, 'x');
});

test('occurrences finds bare AND quoted spellings of the same name', () => {
  const bare = occurrences('SET count = 1;', 'count');
  assert.equal(bare.length, 1);

  const mixed = [
    'DECLARE "count" INTEGER;', // 0: quoted decl
    'SET "count" = 1;', // 1: quoted use
    'SET count = 2;', // 2: bare use
    '-- "count" in a comment does not count', // 3
    "SET t = 'count or \"count\" in a string';", // 4
    '',
  ].join('\n');
  const hits = occurrences(mixed, 'COUNT'); // case-insensitive both ways
  assert.deepEqual(
    hits.map((r) => `${r.start.line}:${r.start.character}-${r.end.character}`),
    ['0:9-14', '1:5-10', '2:4-9'],
    'comment and string spellings excluded'
  );
});

test('occurrences matches the ""-escaped spelling by its unescaped name', () => {
  const text = 'DECLARE "a""b" CHARACTER;\nSET "a""b" = 1;\n';
  const hits = occurrences(text, 'a"b');
  assert.equal(hits.length, 2);
  const raw = text.split('\n');
  assert.equal(raw[0].slice(hits[0].start.character, hits[0].end.character), 'a""b');
});

test('definition and references round-trip a quoted name in both spellings', () => {
  // click the quoted USE on line 5 -> definition is the quoted DECLARE on 1
  const def = definitionAt(SAMPLE, 5, 12);
  assert.ok(def.length >= 1);
  assert.equal(def[0].start.line, 1);
  // references from the declaration see the quoted use (and nothing in the comment)
  const refs = referencesAt(SAMPLE, 1, 15);
  const linesHit = refs.map((r) => r.start.line);
  assert.ok(linesHit.includes(5), 'quoted use found');
  assert.ok(!linesHit.includes(7), 'comment never answers');
});
