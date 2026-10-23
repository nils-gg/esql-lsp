/**
 * Shared test helper for grammar-backed expectations.
 *
 * The server's hardest requirement is that it keeps working — on the Phase 1
 * heuristics — when the tree-sitter addon cannot be built or loaded. Tests of
 * grammar-only behaviour must therefore SKIP rather than fail in such an
 * environment (CI runs a job for exactly that case).
 */

import type { TestContext } from 'node:test';
import { initGrammar } from '../src/parser';

/** True when the grammar is usable; skips the test and returns false if not. */
export async function skipWithoutGrammar(t: TestContext): Promise<boolean> {
  if (await initGrammar()) return true;
  t.skip('tree-sitter addon unavailable — grammar-backed behaviour not expected');
  return false;
}
