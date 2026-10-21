import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { scan, findBeginToken, findEndToken } from '../src/scanner';

test('masked text preserves length and line structure', () => {
  const src = "SET x = 'a--b'; -- comment\nSET y = 2;";
  const { masked, lines } = scan(src);
  assert.equal(masked.length, src.length);
  assert.equal(lines.length, 2);
  assert.equal(masked.split('\n').length, 2);
});

test('line comments are masked, code is kept', () => {
  const { masked } = scan('SET x = 1; -- END MODULE');
  assert.equal(masked, 'SET x = 1;              ');
});

/** n spaces — used to build masked expectations without manual counting. */
const blank = (n: number) => ' '.repeat(n);

test('block comments (incl. multiline) are masked', () => {
  const { masked } = scan('A /* begin\nstuff -- here */ B');
  const lines = masked.split('\n');
  assert.equal(lines[0], 'A ' + blank(8));
  // line 2: `stuff -- here` (comment, 13) + ` ` (code) + `*/` (2) + ` B`
  assert.equal(lines[1], blank(13) + ' ' + blank(2) + ' B');
});

test('string contents are masked (including -- and keywords)', () => {
  const { masked } = scan("SET x = 'END MODULE -- BEGIN';");
  assert.equal(masked, 'SET x = ' + blank(19 + 2) + ';');
});

test('escaped quotes inside strings are handled', () => {
  const { masked } = scan("SET x = 'It''s';");
  assert.equal(masked, 'SET x = ' + blank(7) + ';');
});

test('double-quoted strings are masked', () => {
  const { masked } = scan('SET OutputRoot.HTTPRequestHeader."Content-Type" = \'application/json\';');
  assert.equal(
    masked,
    'SET OutputRoot.HTTPRequestHeader.' + blank(12 + 2) + ' = ' + blank(16 + 2) + ';'
  );
});

test('unterminated string recovers at end of line', () => {
  const { masked } = scan("SET x = 'oops\nSET y = 1;");
  const lines = masked.split('\n');
  assert.equal(lines[0], 'SET x = ' + blank(5));
  assert.equal(lines[1], 'SET y = 1;');
});

test('findBeginToken / findEndToken distinguish standalone END', () => {
  assert.ok(findBeginToken('\tBEGIN') >= 0);
  assert.ok(findBeginToken('x BEGIN') >= 0);
  assert.ok(findBeginToken('begin;') >= 0); // case-insensitive
  assert.equal(findBeginToken('x = 1'), -1);

  assert.ok(findEndToken('END;') >= 0);
  assert.equal(findEndToken('END IF;'), -1);
  assert.equal(findEndToken('END WHILE;'), -1);
  assert.equal(findEndToken('END FOR;'), -1);
  assert.equal(findEndToken('END CASE;'), -1);
  assert.equal(findEndToken('END LOOP;'), -1);
  assert.equal(findEndToken('END MODULE;'), -1);
  assert.equal(findEndToken('END FUNCTION;'), -1);
  assert.equal(findEndToken('END PROCEDURE;'), -1);
  // `end` is a case-insensitive ESQL keyword — it must count as END.
  assert.equal(findEndToken('end;'), 0);
  assert.equal(findEndToken('x = 1'), -1);
});
