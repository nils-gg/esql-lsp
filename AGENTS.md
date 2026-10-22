# AGENTS.md

ESQL (IBM ACE/IIB) language server in TypeScript + a bundled tree-sitter grammar.
Two npm packages: repo root (the LSP server) and `tree-sitter-esql/` (the grammar,
consumed via the `"file:tree-sitter-esql"` dependency, symlinked in `node_modules/`).

## Commands

- `npm run build` — `tsc -p ./`; compiles **both** `src/` and `test/` into `dist/`.
- `npm test` — builds, then runs `node --test dist/test/*.test.js`. Tests run on
  compiled JS only; there is no direct-TS test runner.
  - Single file: `npm run build && node --test dist/test/diagnostics.test.js`
  - Single case: `node --test --test-name-pattern 'missing END MODULE' dist/test/diagnostics.test.js`
- `test/e2e.test.ts` spawns the compiled `dist/src/server.js` as a child process
  and speaks LSP over stdio — build before testing; never expect a TS-aware runner.
- `bin/esql-lsp.js` and all clients run the **built** `dist/src/server.js`.
  Editing `src/` does nothing until `npm run build` + client restart (`:LspRestart`).

## Grammar workflow (tree-sitter-esql/)

- After editing `grammar.js`: `cd tree-sitter-esql && npx tree-sitter generate && npx tree-sitter test` (CLI 0.27 via devDependency).
- **Gotcha:** `tree-sitter generate` regenerates the *committed* `src/parser.c`,
  `src/node-types.json`, `src/grammar.json` but does **not** rebuild the Node
  N-API addon in `tree-sitter-esql/build/`. The server and root tests load the
  addon, so corpus tests can pass against the new grammar while the server still
  runs the stale one. After generate: `cd tree-sitter-esql && npm rebuild`, then
  re-run root `npm test`.
- Never hand-edit generated files (`parser.c`, `node-types.json`, `grammar.json`) — regenerate.
- Corpus tests live in `test/corpus/*.txt` using the two-`===` name format; every
  new/changed construct needs one. Conflicts during `generate` are the hard part —
  document rule-level conflict tricks in grammar comments.

## Architecture constraints

- `src/parser.ts` is the **only** tree-sitter consumer and must degrade to the
  Phase 1 heuristics (`src/scanner.ts` + regex checks) whenever the native addon
  can't build or load (no C toolchain). The server logs which mode is active at
  startup. Every grammar-backed feature needs a heuristic fallback **and a test for it**.
- `parser.ts`'s `analyzeDocument()` walk extracts declared names, SET targets and
  ERROR/inserted-token regions from specific node types. Renaming grammar node
  types silently breaks these extractions — always run root `npm test` after grammar changes.
- The grammar is a deliberate **permissive superset** of the IBM ACE 12.0.x railroad
  diagrams: strictness belongs in the analyzer layer, not the grammar. When a test
  fixture disagrees with `grammar.js`, decide deliberately which is wrong and record
  the reasoning (CONTRIBUTING.md ground rule).
- Every diagnostic is switchable via `initializationOptions` /
  `didChangeConfiguration`. A new check requires: unit test + e2e assertion over a
  real stdio session + a settings-toggle case (`test/e2e.test.ts`).
- e2e fixtures are line-number-coupled to request positions — when editing fixture
  ESQL text, re-verify the positions.

## Verification expectations

- No CI. "Green" means **both** suites: `npm test` (root, ~50 tests) and
  `npx tree-sitter test` (grammar, ~71 corpus tests).
- Known grammar deviations from the IBM reference: `tree-sitter-esql/VERIFICATION.md`.
- Protocol wiring belongs in `src/server.ts`; analysis in the feature modules
  (`diagnostics.ts`, `completion.ts`, `hover.ts`, `symbols.ts`); ESQL data in
  `src/data/`.

See `README.md` + `CONTRIBUTING.md` for feature/docs detail; CONTRIBUTING's ground
rules are reflected above.
