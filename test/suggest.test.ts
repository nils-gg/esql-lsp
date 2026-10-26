import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { editDistance, didYouMean } from '../src/suggest';

// src/suggest.ts is pure TypeScript — these run identically with and without
// the grammar addon (the ESQL_LSP_NO_GRAMMAR=1 suite exercises them too).

test('editDistance is plain Levenshtein', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('SET', 'SET'), 0);
  assert.equal(editDistance('SET', 'SETN'), 1, 'the E-1 transposition distance');
  assert.equal(editDistance('DELCARE', 'DECLARE'), 2, 'a swap is two edits');
  assert.equal(editDistance('', 'abc'), 3);
});

test('the bound reports "farther than the cap" without computing more', () => {
  // Contract: a result > maxDist means "outside the cap", the true value is
  // not promised (computing it would defeat the bound).
  assert.equal(editDistance('abcdef', 'xyz', 2), 3);
  assert.equal(editDistance('a'.repeat(40), 'b'.repeat(40), 1), 2, 'row aborts early');
  assert.equal(editDistance('x'.repeat(40), 'y'.repeat(40)), 40, 'unbounded is exact');
});

test('didYouMean is case-insensitive but returns the candidate spelling', () => {
  assert.deepEqual(didYouMean('setn', ['SET', 'GET'], 1), ['SET']);
  assert.deepEqual(didYouMean('coalsece', ['COALESCE']), ['COALESCE']);
  assert.deepEqual(didYouMean('TRUUE', ['TRUE', 'FALSE']), ['TRUE']);
});

test('an exact match is not a suggestion (distance 0 excluded)', () => {
  // The undeclared-name paths will call this with the name itself possibly
  // IN the list; "did you mean the word you already typed" is not help.
  assert.deepEqual(didYouMean('SET', ['SET']), []);
  assert.deepEqual(didYouMean('set', ['SET', 'SETS']), ['SETS']);
});

test('the empty-list contract: nothing to offer is an answer, not a guess', () => {
  assert.deepEqual(didYouMean('SETN', []), []);
  assert.deepEqual(didYouMean('', ['SET']), []);
  assert.deepEqual(didYouMean('zzzzzz', ['SET'], 2), [], 'beyond the cap: silent');
});

test('closest first; ties keep the candidate list order', () => {
  // Lists may therefore be ordered by preference (a later caller can put
  // workspace routines before unrelated keywords).
  // SETP→SET is 1 deletion; SETP→STEP is a swap = 2 edits.
  assert.deepEqual(didYouMean('SETP', ['SET', 'STEP'], 2), ['SET', 'STEP'], 'closest first');
  assert.deepEqual(didYouMean('SETP', ['SET', 'STEP'], 1), ['SET'], 'the swap is outside a cap of 1');
  // GETN (one substitution) and SET (one deletion) tie at 1: input order wins.
  assert.deepEqual(didYouMean('SETN', ['GETN', 'SET'], 1), ['GETN', 'SET']);
  // TURE→TRUE is a swap = 2; RETURN is far outside any cap.
  assert.deepEqual(didYouMean('TURE', ['TRUE', 'RETURN'], 2), ['TRUE']);
});
