/**
 * Near-neighbour ("did you mean") suggestions — CODE_REVIEW.md E-10.
 *
 * The server already holds every list a suggestion could come from (keyword
 * table, data types, declared names, workspace routines); what was missing was
 * the one utility that turns a typo into a candidate: a bounded edit-distance
 * search. Kept free of grammar and LSP types so `parser.ts`, `diagnostics.ts`
 * and `server.ts` can all share it.
 */

/**
 * Levenshtein edit distance between `a` and `b`, computing nothing past
 * `maxDist`: a row whose minimum already exceeds the cap aborts, and a
 * candidate whose LENGTH differs by more than the cap is rejected outright.
 * The lists are small but searched per diagnostic (which is per keystroke),
 * so the cap is the difference between a table scan and a table sweep.
 *
 * Returns a value GREATER than `maxDist` (`maxDist + 1`, and `Infinity` when
 * `maxDist` is unbounded) when the true distance exceeds the cap — callers
 * only ever compare against `maxDist`, and recomputing the real distance to
 * report it would undo the whole point of bounding the search.
 */
export function editDistance(a: string, b: string, maxDist = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  // Rolling DP rows; `prev[j]` = distance(a[0..i-1], b[0..j]).
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDist) return maxDist + 1; // no completion of this row can land inside the cap
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Every candidate within `maxDist` edits of `word`, closest first (ties keep
 * the candidate list's own order). Comparison is case-INSENSITIVE — ESQL
 * identifiers and keywords are — but the candidate's ORIGINAL spelling is
 * returned, because that is what the message should print.
 *
 * The contract that keeps suggestions honest: an empty array means "no
 * suggestion" and callers must say nothing. A near-hit above the distance cap
 * is a wrong guess dressed up as help, and an exact match is not a suggestion
 * (distance 0 is excluded by design).
 */
export function didYouMean(word: string, candidates: readonly string[], maxDist = 2): string[] {
  if (!word || maxDist < 1 || candidates.length === 0) return [];
  const w = word.toLowerCase();
  const hits: Array<{ name: string; d: number }> = [];
  for (const c of candidates) {
    if (!c) continue;
    const d = editDistance(w, c.toLowerCase(), maxDist);
    if (d >= 1 && d <= maxDist) hits.push({ name: c, d });
  }
  // V8's sort is stable: equal distances keep the caller's list order, so
  // candidate lists can be ordered by preference.
  hits.sort((x, y) => x.d - y.d);
  return hits.map((h) => h.name);
}
